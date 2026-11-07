import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { UsageRecord } from '@tokenaires/contracts';
import { eachLine } from '@/files/lines';
import {
  bytesHave,
  child,
  count,
  epochTime,
  isoTime,
  markerBuffers,
  parseObject,
  text,
  type JsonObject,
} from '@/parsers/json';
import { hasTokens } from '@/parsers/merge';

const ID_PREFIX = 'hermes:';
const ID_HEX_LENGTH = 32;
const EPOCH = /^\d+(\.\d+)?$/;
const ZONELESS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const MARKERS = markerBuffers('"usage"', '"input_tokens"', '"output_tokens"', '"prompt_tokens"', '"tokens"');

function rawPart(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export interface Tokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export function hermesTime(value: unknown): string | null {
  if (typeof value === 'number') {
    return epochTime(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw.length === 0) return null;
  if (EPOCH.test(raw)) {
    const num = Number(raw);
    return epochTime(num < 1e12 ? num * 1000 : num);
  }
  return isoTime(ZONELESS.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw);
}

export function hermesRecordId(...parts: (string | number | null | undefined)[]): string {
  const content = parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('|');
  const digest = createHash('sha256').update(content).digest('hex').slice(0, ID_HEX_LENGTH);
  return `${ID_PREFIX}${digest}`;
}

export function hermesTokens(usage: JsonObject): Tokens {
  const details = child(usage, 'inputTokenDetails') ?? child(usage, 'input_token_details');
  const cacheReadTokens =
    count(details, 'cacheReadTokens') ||
    count(details, 'cache_read_tokens') ||
    count(usage, 'cacheReadTokens') ||
    count(usage, 'cache_read_tokens') ||
    count(usage, 'cached_tokens');
  const cacheWriteTokens =
    count(details, 'cacheWriteTokens') ||
    count(details, 'cache_write_tokens') ||
    count(usage, 'cacheWriteTokens') ||
    count(usage, 'cache_write_tokens');

  const rawInput =
    count(details, 'noCacheTokens') ||
    count(details, 'no_cache_tokens') ||
    count(usage, 'input_tokens') ||
    count(usage, 'inputTokens') ||
    count(usage, 'prompt_tokens');
  const cached = cacheReadTokens + cacheWriteTokens;
  const inputTokens =
    details && (typeof details.noCacheTokens === 'number' || typeof details.no_cache_tokens === 'number')
      ? rawInput
      : cached <= rawInput
        ? rawInput - cached
        : rawInput;

  const rawOutput =
    count(usage, 'output_tokens') ||
    count(usage, 'outputTokens') ||
    count(usage, 'completion_tokens');
  const outDetails = child(usage, 'outputTokenDetails') ?? child(usage, 'output_token_details');
  const reasoningTokens =
    count(outDetails, 'reasoningTokens') ||
    count(outDetails, 'reasoning_tokens') ||
    count(usage, 'reasoning_tokens') ||
    count(usage, 'reasoningTokens') ||
    count(usage, 'thinking_tokens');
  const total = count(usage, 'total_tokens') || count(usage, 'totalTokens');
  const separate = reasoningTokens > rawOutput || (total > 0 && total === rawInput + rawOutput + reasoningTokens);
  const outputTokens = separate ? rawOutput + reasoningTokens : rawOutput;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: separate ? reasoningTokens : Math.min(reasoningTokens, outputTokens),
  };
}

export function readHermesDb(db: DatabaseSync): UsageRecord[] {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name),
  );
  const into = new Map<string, UsageRecord>();

  if (tables.has('session_model_usage')) {
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(session_model_usage)')
        .all()
        .map((row) => (row as { name: string }).name),
    );
    if (columns.has('session_id') && columns.has('model')) {
      const selectCols = [
        'session_id',
        'model',
        columns.has('billing_provider') ? 'billing_provider' : 'NULL AS billing_provider',
        columns.has('billing_mode') ? 'billing_mode' : 'NULL AS billing_mode',
        columns.has('task') ? 'task' : 'NULL AS task',
        columns.has('input_tokens') ? 'input_tokens' : '0 AS input_tokens',
        columns.has('output_tokens') ? 'output_tokens' : '0 AS output_tokens',
        columns.has('cache_read_tokens') ? 'cache_read_tokens' : '0 AS cache_read_tokens',
        columns.has('cache_write_tokens') ? 'cache_write_tokens' : '0 AS cache_write_tokens',
        columns.has('reasoning_tokens') ? 'reasoning_tokens' : '0 AS reasoning_tokens',
        columns.has('first_seen') ? 'first_seen' : 'NULL AS first_seen',
        columns.has('last_seen') ? 'last_seen' : 'NULL AS last_seen',
      ].join(', ');

      for (const row of db.prepare(`SELECT ${selectCols} FROM session_model_usage`).all() as JsonObject[]) {
        const sessionId = text(row, 'session_id');
        const model = text(row, 'model');
        const occurredAt = hermesTime(row.first_seen ?? row.last_seen);
        if (!sessionId || !model || !occurredAt) continue;
        const task = text(row, 'task');
        const provider = text(row, 'billing_provider');
        const recordId = hermesRecordId('smu', sessionId, model, provider, task, occurredAt);
        const record: UsageRecord = {
          source: 'hermes-cli',
          recordId,
          model,
          occurredAt,
          ...hermesTokens(row),
        };
        if (hasTokens(record) && !into.has(record.recordId)) {
          into.set(record.recordId, record);
        }
      }
    }
  }

  if (into.size === 0 && tables.has('sessions')) {
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(sessions)')
        .all()
        .map((row) => (row as { name: string }).name),
    );
    if (columns.has('id')) {
      const selectCols = [
        'id',
        columns.has('model') ? 'model' : "'hermes' AS model",
        columns.has('started_at') ? 'started_at' : 'NULL AS started_at',
        columns.has('ended_at') ? 'ended_at' : 'NULL AS ended_at',
        columns.has('created_at') ? 'created_at' : 'NULL AS created_at',
        columns.has('input_tokens') ? 'input_tokens' : '0 AS input_tokens',
        columns.has('output_tokens') ? 'output_tokens' : '0 AS output_tokens',
        columns.has('cache_read_tokens') ? 'cache_read_tokens' : '0 AS cache_read_tokens',
        columns.has('cache_write_tokens') ? 'cache_write_tokens' : '0 AS cache_write_tokens',
        columns.has('reasoning_tokens') ? 'reasoning_tokens' : '0 AS reasoning_tokens',
      ].join(', ');

      for (const row of db.prepare(`SELECT ${selectCols} FROM sessions`).all() as JsonObject[]) {
        const id = text(row, 'id');
        const model = text(row, 'model');
        const occurredAt = hermesTime(row.started_at ?? row.ended_at ?? row.created_at);
        if (!id || !model || !occurredAt) continue;
        const recordId = hermesRecordId('sess', id, occurredAt);
        const record: UsageRecord = {
          source: 'hermes-cli',
          recordId,
          model,
          occurredAt,
          ...hermesTokens(row),
        };
        if (hasTokens(record) && !into.has(record.recordId)) {
          into.set(record.recordId, record);
        }
      }
    }
  }

  if (into.size === 0 && tables.has('messages')) {
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(messages)')
        .all()
        .map((row) => (row as { name: string }).name),
    );
    if (columns.has('session_id') && columns.has('role')) {
      const selectCols = [
        columns.has('id') ? 'id' : 'NULL AS id',
        'session_id',
        'role',
        columns.has('model') ? 'model' : 'NULL AS model',
        columns.has('timestamp') ? 'timestamp' : columns.has('created_at') ? 'created_at' : 'NULL AS timestamp',
        columns.has('token_count') ? 'token_count' : '0 AS token_count',
      ].join(', ');

      for (const row of db.prepare(`SELECT ${selectCols} FROM messages WHERE role IN ('assistant', 'model')`).all() as JsonObject[]) {
        const sessionId = text(row, 'session_id');
        const occurredAt = hermesTime(row.timestamp);
        const tokenCount = count(row, 'token_count');
        if (!sessionId || !occurredAt || tokenCount <= 0) continue;
        const id = rawPart(row.id);
        const model = text(row, 'model') ?? 'hermes';
        const recordId = hermesRecordId('msg', sessionId, id, occurredAt);
        const record: UsageRecord = {
          source: 'hermes-cli',
          recordId,
          model,
          occurredAt,
          inputTokens: 0,
          outputTokens: tokenCount,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        };
        if (hasTokens(record) && !into.has(record.recordId)) {
          into.set(record.recordId, record);
        }
      }
    }
  }

  return [...into.values()];
}

export function hermesRecordFromLine(line: string): UsageRecord | null {
  const entry = parseObject(line);
  if (!entry) return null;
  const usage = child(entry, 'usage') ?? (count(entry, 'input_tokens') > 0 || count(entry, 'output_tokens') > 0 ? entry : null);
  if (!usage) return null;
  const model = text(entry, 'model') ?? text(usage, 'model') ?? text(child(entry, 'message'), 'model');
  if (!model) return null;
  const occurredAt = hermesTime(entry.timestamp ?? entry.created_at ?? usage.timestamp);
  if (!occurredAt) return null;
  const id = text(entry, 'id') ?? text(entry, 'session_id') ?? text(child(entry, 'message'), 'id') ?? text(entry, 'call_id');
  const recordId = hermesRecordId('jsonl', id, model, occurredAt);
  const record: UsageRecord = {
    source: 'hermes-cli',
    recordId,
    model,
    occurredAt,
    ...hermesTokens(usage),
  };
  return hasTokens(record) ? record : null;
}

export async function parseHermesJsonlFile(path: string): Promise<UsageRecord[] | null> {
  const into = new Map<string, UsageRecord>();
  const ok = await eachLine(path, (line) => {
    if (!bytesHave(line, MARKERS)) return;
    const record = hermesRecordFromLine(line.toString('utf8'));
    if (record) into.set(record.recordId, record);
  });
  return ok ? [...into.values()] : null;
}
