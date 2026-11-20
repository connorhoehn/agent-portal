// Loads OPENAI_API_KEY in-process for live runs: the environment first, then the main checkout's gitignored middleware/.env
// (MILO_JUDGE_ENV overrides the path). The key is never printed or written.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function openAiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const here = dirname(fileURLToPath(import.meta.url));
  // <repo>/scripts/milo-judge -> a linked worktree lives under <main>/.claude/worktrees/<name>
  const candidates = [process.env.MILO_JUDGE_ENV, resolve(here, '../../middleware/.env'), resolve(here, '../../../../../middleware/.env')].filter((x): x is string => !!x);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*OPENAI_API_KEY\s*=\s*(.*)\s*$/.exec(line);
      if (m) return m[1]!.replace(/^['"]|['"]$/g, '');
    }
  }
  throw new Error('OPENAI_API_KEY not found: set it, or set MILO_JUDGE_ENV to an env file that has it');
}
