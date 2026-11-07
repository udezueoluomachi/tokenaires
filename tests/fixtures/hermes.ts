import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const HERMES_SECRET = 'HERMES_TOP_SECRET_PROMPT';
export const HERMES_SESSION_A = 'hermes-sess-011AAAAAAAAAAAA';
export const HERMES_SESSION_B = 'hermes-sess-011BBBBBBBBBBBB';

export interface HermesUsageRow {
  sessionId: string;
  model: string;
  firstSeen?: string | number | null;
  lastSeen?: string | number | null;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  provider?: string | null;
  task?: string | null;
}

export interface HermesDbOptions {
  includeModelUsage?: boolean;
  includeSessions?: boolean;
  includeMessages?: boolean;
}

export async function createHermesDb(
  path: string,
  rows: readonly HermesUsageRow[],
  options: HermesDbOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  if (options.includeModelUsage !== false) {
    db.exec(`CREATE TABLE session_model_usage (
      session_id TEXT,
      model TEXT,
      billing_provider TEXT,
      billing_base_url TEXT,
      billing_mode TEXT,
      task TEXT,
      api_call_count INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      first_seen REAL,
      last_seen REAL,
      PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
    )`);

    const insert = db.prepare(`INSERT INTO session_model_usage (
      session_id, model, billing_provider, billing_base_url, billing_mode, task, api_call_count,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      estimated_cost_usd, actual_cost_usd, first_seen, last_seen
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const row of rows) {
      insert.run(
        row.sessionId,
        row.model,
        row.provider ?? 'anthropic',
        'https://api.anthropic.com',
        'direct',
        row.task ?? '',
        1,
        row.input,
        row.output,
        row.cacheRead ?? 0,
        row.cacheWrite ?? 0,
        row.reasoning ?? 0,
        0.01,
        0.01,
        row.firstSeen ?? 1_790_000_000,
        row.lastSeen ?? 1_790_000_000,
      );
    }
  }

  if (options.includeSessions) {
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT,
      model TEXT,
      system_prompt TEXT,
      started_at REAL,
      ended_at REAL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER
    )`);
    const insert = db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rows) {
      insert.run(
        row.sessionId,
        'cli',
        row.model,
        HERMES_SECRET,
        row.firstSeen ?? 1_790_000_000,
        row.lastSeen ?? 1_790_000_000,
        row.input,
        row.output,
        row.cacheRead ?? 0,
        row.cacheWrite ?? 0,
        row.reasoning ?? 0,
      );
    }
  }

  if (options.includeMessages) {
    db.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT,
      content TEXT,
      timestamp REAL,
      token_count INTEGER,
      model TEXT
    )`);
    const insert = db.prepare(`INSERT INTO messages (session_id, role, content, timestamp, token_count, model)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const row of rows) {
      insert.run(
        row.sessionId,
        'assistant',
        HERMES_SECRET,
        row.firstSeen ?? 1_790_000_000,
        row.output,
        row.model,
      );
    }
  }

  db.close();
}

export const hermesJsonlSession = [
  JSON.stringify({ type: 'session', id: HERMES_SESSION_A, cwd: '/Users/someone/secret', prompt: HERMES_SECRET }),
  JSON.stringify({
    type: 'usage',
    model: 'nous-hermes-3-llama-3.1-405b',
    timestamp: '2026-10-01T10:00:00.000Z',
    usage: {
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_tokens: 1000,
      cache_write_tokens: 50,
      reasoning_tokens: 20,
    },
  }),
  JSON.stringify({
    type: 'message',
    role: 'user',
    content: HERMES_SECRET,
  }),
  JSON.stringify({
    type: 'message',
    role: 'assistant',
    id: 'msg_hermes_001',
    model: 'nous-hermes-3-llama-3.1-70b',
    timestamp: '2026-10-02T12:00:00.000Z',
    content: 'Sure! Here is the response',
    usage: {
      input_tokens: 250,
      output_tokens: 50,
      total_tokens: 300,
    },
  }),
  '{"broken json line',
  '',
];
