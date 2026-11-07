import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hermesTime, hermesTokens, parseHermesJsonlFile } from '@/parsers/hermes';
import { hermesHome, hermesHomes } from '@/parsers/paths';
import { RECORD_ID_PATTERN } from '@/parsers/json';
import { scanLocal } from '@/scan';
import { hermesSource } from '@/sources/hermes';
import {
  createHermesDb,
  HERMES_SECRET,
  HERMES_SESSION_A,
  HERMES_SESSION_B,
  hermesJsonlSession,
} from './fixtures/hermes';
import { makeTempDir, removeDir, writeLines } from './helpers/temp';

describe('Hermes CLI parser', () => {
  let root = '';
  let dbPath = '';

  beforeEach(async () => {
    root = await makeTempDir('hermes');
    dbPath = join(root, '.hermes', 'state.db');
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it('parses session_model_usage from state.db with cache tokens subtracted and valid record id', async () => {
    await createHermesDb(dbPath, [
      {
        sessionId: HERMES_SESSION_A,
        model: 'nous-hermes-3-llama-3.1-405b',
        firstSeen: 1_790_000_000,
        input: 12_000,
        output: 400,
        cacheRead: 9_000,
        cacheWrite: 1_000,
        reasoning: 150,
        task: 'coding',
      },
      {
        sessionId: HERMES_SESSION_A,
        model: 'nous-hermes-3-llama-3.1-70b',
        firstSeen: 1_790_001_000,
        input: 5_000,
        output: 900,
        task: 'compression',
      },
    ]);

    const records = (await hermesSource.parse(dbPath)) ?? [];
    expect(records).toHaveLength(2);

    expect(records[0]).toMatchObject({
      source: 'hermes-cli',
      model: 'nous-hermes-3-llama-3.1-405b',
      occurredAt: new Date(1_790_000_000_000).toISOString(),
      inputTokens: 2_000,
      outputTokens: 400,
      cacheReadTokens: 9_000,
      cacheWriteTokens: 1_000,
      reasoningTokens: 150,
    });

    expect(records[1]).toMatchObject({
      source: 'hermes-cli',
      model: 'nous-hermes-3-llama-3.1-70b',
      occurredAt: new Date(1_790_001_000_000).toISOString(),
      inputTokens: 5_000,
      outputTokens: 900,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });

    for (const record of records) {
      expect(record.recordId).toMatch(RECORD_ID_PATTERN);
    }
  });

  it('falls back to sessions table when session_model_usage is absent', async () => {
    await createHermesDb(
      dbPath,
      [
        {
          sessionId: HERMES_SESSION_B,
          model: 'nous-hermes-3-llama-3.1-8b',
          firstSeen: 1_790_000_500,
          input: 800,
          output: 120,
          cacheRead: 200,
        },
      ],
      { includeModelUsage: false, includeSessions: true },
    );

    const records = (await hermesSource.parse(dbPath)) ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: 'hermes-cli',
      model: 'nous-hermes-3-llama-3.1-8b',
      inputTokens: 600,
      outputTokens: 120,
      cacheReadTokens: 200,
    });
    expect(records[0]?.recordId).toMatch(RECORD_ID_PATTERN);
  });

  it('falls back to messages table when session_model_usage and sessions are absent', async () => {
    await createHermesDb(
      dbPath,
      [
        {
          sessionId: HERMES_SESSION_A,
          model: 'hermes-model-custom',
          firstSeen: 1_790_000_000,
          input: 0,
          output: 75,
        },
      ],
      { includeModelUsage: false, includeSessions: false, includeMessages: true },
    );

    const records = (await hermesSource.parse(dbPath)) ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: 'hermes-cli',
      model: 'hermes-model-custom',
      outputTokens: 75,
    });
    expect(records[0]?.recordId).toMatch(RECORD_ID_PATTERN);
  });

  it('parses JSONL session files and skips non-usage / broken lines', async () => {
    const jsonlPath = join(root, '.hermes', 'sessions', 'session-01.jsonl');
    await writeLines(jsonlPath, hermesJsonlSession);

    const records = (await parseHermesJsonlFile(jsonlPath)) ?? [];
    expect(records).toHaveLength(2);

    expect(records[0]).toMatchObject({
      source: 'hermes-cli',
      model: 'nous-hermes-3-llama-3.1-405b',
      occurredAt: '2026-10-01T10:00:00.000Z',
      inputTokens: 150,
      outputTokens: 80,
      cacheReadTokens: 1000,
      cacheWriteTokens: 50,
      reasoningTokens: 20,
    });

    expect(records[1]).toMatchObject({
      source: 'hermes-cli',
      model: 'nous-hermes-3-llama-3.1-70b',
      occurredAt: '2026-10-02T12:00:00.000Z',
      inputTokens: 250,
      outputTokens: 50,
    });

    for (const record of records) {
      expect(record.recordId).toMatch(RECORD_ID_PATTERN);
    }
  });

  it('never leaks prompt text, cwd, or secrets into records', async () => {
    await createHermesDb(
      dbPath,
      [
        {
          sessionId: HERMES_SESSION_A,
          model: 'nous-hermes-test',
          firstSeen: 1_790_000_000,
          input: 100,
          output: 20,
        },
      ],
      { includeSessions: true, includeMessages: true },
    );

    const records = (await hermesSource.parse(dbPath)) ?? [];
    const text = JSON.stringify(records);
    expect(text).not.toContain(HERMES_SECRET);
    expect(text).not.toContain('/Users/someone');
  });

  it('calculates tokens correctly for different input and output details', () => {
    expect(
      hermesTokens({
        input_tokens: 1500,
        output_tokens: 100,
        total_tokens: 1600,
        cache_read_tokens: 1000,
        cache_write_tokens: 100,
        reasoning_tokens: 40,
      }),
    ).toEqual({
      inputTokens: 400,
      outputTokens: 100,
      cacheReadTokens: 1000,
      cacheWriteTokens: 100,
      reasoningTokens: 40,
    });

    expect(
      hermesTokens({
        input_tokens: 500,
        output_tokens: 80,
        input_token_details: {
          no_cache_tokens: 300,
          cache_read_tokens: 200,
        },
        output_token_details: {
          reasoning_tokens: 25,
        },
      }),
    ).toEqual({
      inputTokens: 300,
      outputTokens: 80,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      reasoningTokens: 25,
    });
  });

  it('parses timestamps across epoch seconds, milliseconds, and zoneless strings', () => {
    expect(hermesTime(1_790_000_000)).toBe(new Date(1_790_000_000_000).toISOString());
    expect(hermesTime(1_790_000_000_000)).toBe(new Date(1_790_000_000_000).toISOString());
    expect(hermesTime('1790000000')).toBe(new Date(1_790_000_000_000).toISOString());
    expect(hermesTime('2026-10-01 10:00:00')).toBe('2026-10-01T10:00:00.000Z');
    expect(hermesTime('2026-10-01T10:00:00.000Z')).toBe('2026-10-01T10:00:00.000Z');
    expect(hermesTime('')).toBeNull();
    expect(hermesTime(null)).toBeNull();
  });

  it('discovers state.db, profile databases, and session transcripts', async () => {
    await createHermesDb(dbPath, [
      { sessionId: HERMES_SESSION_A, model: 'm1', input: 10, output: 5 },
    ]);
    const profileDb = join(root, '.hermes', 'profiles', 'work', 'state.db');
    await createHermesDb(profileDb, [
      { sessionId: HERMES_SESSION_B, model: 'm2', input: 20, output: 8 },
    ]);
    const jsonlFile = join(root, '.hermes', 'logs', 'sessions', 'audit.jsonl');
    await writeLines(jsonlFile, hermesJsonlSession);

    const files = await hermesSource.discover({ env: {}, home: root, platform: 'linux' });
    expect(files).toContain(dbPath);
    expect(files).toContain(profileDb);
    expect(files).toContain(jsonlFile);
  });

  it('respects HERMES_HOME override in discover and paths', async () => {
    const customHome = join(root, 'custom-hermes');
    const customDb = join(customHome, 'state.db');
    await createHermesDb(customDb, [
      { sessionId: HERMES_SESSION_A, model: 'm1', input: 10, output: 5 },
    ]);

    expect(hermesHome({ HERMES_HOME: customHome }, root)).toBe(customHome);
    expect(hermesHomes({ HERMES_HOME: customHome }, root)).toEqual([customHome]);

    const files = await hermesSource.discover({
      env: { HERMES_HOME: customHome },
      home: root,
      platform: 'linux',
    });
    expect(files).toEqual([customDb]);
  });

  it('integrates with scanLocal scanner', async () => {
    await createHermesDb(dbPath, [
      {
        sessionId: HERMES_SESSION_A,
        model: 'nous-hermes-3-llama-3.1-405b',
        firstSeen: 1_790_000_000,
        input: 100,
        output: 50,
      },
    ]);

    const result = await scanLocal({
      env: {},
      home: root,
      cachePath: null,
    });

    const hermesRecords = result.records.filter((r) => r.source === 'hermes-cli');
    expect(hermesRecords).toHaveLength(1);
    expect(hermesRecords[0]?.model).toBe('nous-hermes-3-llama-3.1-405b');
    expect(result.files['hermes-cli']).toBe(1);
  });
});
