// skillsNote from tools/local-compute-skills.mjs, read synchronously for jest (the CJS build cannot
// import an .mjs): the module's text is evaluated in a fresh node and the function's answer returned.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const MODULE = join(__dirname, '..', '..', '..', '..', 'tools', 'local-compute-skills.mjs');

export function skillsNote(result: unknown, briefDir: string | null): string | null {
  const driver = `
    const { skillsNote } = await import(${JSON.stringify(MODULE)});
    process.stdout.write(JSON.stringify(skillsNote(JSON.parse(process.argv[1]), JSON.parse(process.argv[2]))));`;
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', driver, JSON.stringify(result), JSON.stringify(briefDir)], { encoding: 'utf8' });
  if (p.status !== 0) throw new Error(p.stderr);
  return JSON.parse(p.stdout) as string | null;
}
