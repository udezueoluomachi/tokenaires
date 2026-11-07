import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { findAll, listDir } from '@/files/walk';
import { wslHomes } from '@/files/wsl';
import { parseHermesJsonlFile, readHermesDb } from '@/parsers/hermes';
import { hermesHomes } from '@/parsers/paths';
import { dbSignature, withReadOnlyDb } from '@/sqlite/open';
import type { LogSource, SourceContext } from '@/sources/types';

const DB_NAME = 'state.db';

export async function findHermesFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await listDir(dir);
  for (const name of entries) {
    if (name === DB_NAME || name.endsWith('.jsonl')) files.push(join(dir, name));
  }
  const profilesDir = join(dir, 'profiles');
  for (const profile of await listDir(profilesDir)) {
    const pDb = join(profilesDir, profile, DB_NAME);
    try {
      const s = await stat(pDb);
      if (s.isFile()) files.push(pDb);
    } catch {
      // ignore missing profile database
    }
  }
  const sessionRoots = [join(dir, 'sessions'), join(dir, 'logs', 'sessions')];
  const jsonls = await findAll(sessionRoots);
  files.push(...jsonls);
  return files;
}

export async function hermesRoots(ctx: SourceContext): Promise<string[]> {
  const base = hermesHomes(ctx.env, ctx.home, ctx.platform);
  const wsl = await wslHomes(ctx.platform);
  return [...new Set([...base, ...wsl.map((home) => join(home, '.hermes'))])];
}

export const hermesSource: LogSource = {
  source: 'hermes-cli',
  async discover(ctx) {
    const roots = await hermesRoots(ctx);
    const discovered = await Promise.all(roots.map(findHermesFiles));
    return [...new Set(discovered.flat())].sort();
  },
  parse: (path) => (path.endsWith('.db') ? withReadOnlyDb(path, readHermesDb) : parseHermesJsonlFile(path)),
  signature: async (path) => (path.endsWith('.db') ? dbSignature(path) : null),
};
