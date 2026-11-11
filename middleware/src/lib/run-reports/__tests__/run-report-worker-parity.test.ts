// The worker's half of the run report (tools/local-compute-report.mjs) is plain
// Node, so it cannot import the TypeScript it must agree with. This suite holds
// the two to one behaviour: the same skill-load rule as
// lib/run-reports/use-detection.ts, and the same kept-folder reading as
// lib/runbooks/keep.ts (which is `lab keep`'s), on the same hostile inputs.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { skillsLoadedFrom } from '../use-detection.js';
import { readKeepFolder } from '../../runbooks/keep.js';
import { DEBRIEF_ALLOWED_TOOLS, DEBRIEF_ANSWER_SCHEMA, DEBRIEF_DISALLOWED_TOOLS, DEBRIEF_TOOLS } from '../../runbooks/debrief.js';

const MODULE = resolve(__dirname, '../../../../../tools/local-compute-report.mjs');

function worker(fn: string, args: unknown[]): unknown {
  const script = `const m = await import(${JSON.stringify(MODULE)}); const a = JSON.parse(process.argv[1]);
    const r = m[${JSON.stringify(fn)}](...a);
    process.stdout.write(JSON.stringify(r));`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(args)], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(out.stderr);
  return JSON.parse(out.stdout);
}

const skill = (input: Record<string, unknown>, name = 'Skill') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

describe('skill loads: worker and server agree', () => {
  const events: unknown[] = [
    { type: 'system', subtype: 'init', skills: ['rb-not-a-load'] },
    skill({ skill: 'rb-flaky-test-rerun-diff' }),
    skill({ name: 'rb-two' }),
    skill({ command: 'plug:rb-three' }),
    skill({ file_path: '/r/.claude/skills/rb-four/SKILL.md' }, 'Read'),
    skill({ file_path: '/r/.claude/skills/rb-four/scripts/x.sh' }, 'Read'),
    skill({ skill: '../../etc' }),
    skill({ skill: 'rb-flaky-test-rerun-diff' }),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Skill rb-text-only' }] } },
    { type: 'result', subtype: 'success', result: 'done' },
  ];
  it('the same names, in the same order', () => {
    const stdout = [...events.map((e) => JSON.stringify(e)), '{"partial', 'not json'].join('\n');
    expect(worker('skillsLoadedFromStream', [stdout])).toEqual(skillsLoadedFrom(events));
    expect(skillsLoadedFrom(events)).toEqual(['rb-flaky-test-rerun-diff', 'rb-two', 'rb-three', 'rb-four']);
  });
});

describe('kept folders: worker and lab keep agree', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'keep-parity-'));
    const keep = join(dir, '.lab', 'keep');
    const good = join(keep, 'rb-collector-rerun');
    mkdirSync(join(good, 'scripts'), { recursive: true });
    mkdirSync(join(good, 'data'), { recursive: true });
    writeFileSync(join(good, 'SKILL.md'), '---\nname: rb-collector-rerun\ndescription: Rerun a collector test twice and compare.\n---\n# Rerun\n');
    writeFileSync(join(good, 'scripts', 'rerun.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(good, 'scripts', 'rerun.sh'), 0o755);
    writeFileSync(join(good, 'data', 'sample.txt'), 'a\n');
    const edit = join(keep, 'rb-installed-one');
    mkdirSync(edit, { recursive: true });
    writeFileSync(join(edit, 'SKILL.md'), '---\nname: rb-installed-one\ndescription: x\n---\n');
    const bad = join(keep, 'Bad_Name');
    mkdirSync(join(bad, 'scripts'), { recursive: true });
    writeFileSync(join(bad, 'scripts', 'bin.dat'), Buffer.from([1, 0, 2]));
    symlinkSync('/etc/hosts', join(bad, 'scripts', 'hosts'));
    const big = join(keep, 'rb-too-big');
    mkdirSync(join(big, 'data'), { recursive: true });
    writeFileSync(join(big, 'SKILL.md'), 'x');
    writeFileSync(join(big, 'data', 'big.txt'), 'y'.repeat(40 * 1024));
    symlinkSync(good, join(keep, 'rb-linked'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('the same bodies and the same refusals', () => {
    const keepDir = join(dir, '.lab', 'keep');
    const opts = { runRef: 'job-1', sessionId: 'local-s', installed: new Set(['rb-installed-one']) };
    const ts = readKeepFolder(keepDir, opts);
    // `installed` is a Set inside the options object, so this one call is spelled out.
    const js = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(MODULE)}); process.stdout.write(JSON.stringify(m.readKeptFolders(process.argv[1], { runRef: 'job-1', sessionId: 'local-s', installed: new Set(['rb-installed-one']) })));`, keepDir],
    { encoding: 'utf8' });
    expect(js.status).toBe(0);
    expect(JSON.parse(js.stdout)).toEqual(JSON.parse(JSON.stringify(ts)));
    const names = ts.map((k) => k.name);
    expect(names).toEqual(['Bad_Name', 'rb-collector-rerun', 'rb-installed-one', 'rb-too-big']);
    expect(ts.find((k) => k.name === 'rb-installed-one')!.body!.kind).toBe('edit');
    expect(ts.find((k) => k.name === 'rb-collector-rerun')!.body!.files.map((f) => `${f.path} ${f.mode}`)).toEqual(['scripts/rerun.sh 755', 'data/sample.txt 644']);
    expect(ts.find((k) => k.name === 'Bad_Name')!.problems!.length).toBeGreaterThan(0);
    expect(ts.find((k) => k.name === 'rb-too-big')!.problems!.join(' ')).toMatch(/bytes/);
  });

  it('buildReport: tail of the final message, the stream\'s loads, the checkout\'s keeps', () => {
    const r = worker('buildReport', [{ finalMessage: 'x'.repeat(70_000) + '\n```lab-report\n{}\n```', stdout: JSON.stringify(skill({ skill: 'rb-a' })), workdir: dir, runRef: 'job-9', sessionId: 's' }]) as {
      block: string; skillsLoaded: string[]; kept: Array<{ name: string }>;
    };
    expect(r.block.length).toBe(4 * 16_384);
    expect(r.block.endsWith('```')).toBe(true);
    expect(r.skillsLoaded).toEqual(['rb-a']);
    expect(r.kept.map((k) => k.name)).toContain('rb-collector-rerun');
    const none = worker('buildReport', [{ finalMessage: '', stdout: '', workdir: null, runRef: 'j', sessionId: '' }]);
    expect(none).toEqual({ block: null, skillsLoaded: [], kept: [] });
  });
});

describe('the debrief: the server asks, the worker only narrows', () => {
  const SID = '0b7c6a52-3d1e-4f6a-9a1b-2c3d4e5f6a7b';
  const request = {
    prompt: 'debrief', schema: DEBRIEF_ANSWER_SCHEMA, maxBudgetUsd: 0.5,
    tools: [...DEBRIEF_TOOLS], allowedTools: [...DEBRIEF_ALLOWED_TOOLS], disallowedTools: [...DEBRIEF_DISALLOWED_TOOLS],
  };
  it("the server's request becomes exactly the resume argv", () => {
    expect(worker('debriefArgs', [request, { sessionId: SID, model: 'claude-haiku-4-5-20251001' }])).toEqual([
      '-p', 'debrief', '--resume', SID, '--fork-session', '--output-format', 'json',
      '--json-schema', JSON.stringify(DEBRIEF_ANSWER_SCHEMA), '--model', 'claude-haiku-4-5-20251001',
      '--tools', DEBRIEF_TOOLS.join(','), '--allowedTools', DEBRIEF_ALLOWED_TOOLS.join(','),
      '--disallowedTools', DEBRIEF_DISALLOWED_TOOLS.join(','), '--permission-mode', 'dontAsk', '--max-budget-usd', '0.5',
    ]);
  });
  it('a widened request is narrowed, and a bad session id runs nothing', () => {
    const wide = {
      ...request, maxBudgetUsd: 50, tools: ['Bash', ...request.tools],
      allowedTools: ['Bash(*)', 'Edit(./**)', ...request.allowedTools], disallowedTools: [],
    };
    const a = worker('debriefArgs', [wide, { sessionId: SID }]) as string[];
    expect(a[a.indexOf('--tools') + 1]).toBe(DEBRIEF_TOOLS.join(','));
    expect(a[a.indexOf('--allowedTools') + 1]).toBe(DEBRIEF_ALLOWED_TOOLS.join(','));
    expect(a[a.indexOf('--disallowedTools') + 1]).toBe(DEBRIEF_DISALLOWED_TOOLS.join(','));
    expect(a[a.indexOf('--max-budget-usd') + 1]).toBe('2');
    expect(worker('debriefArgs', [request, { sessionId: '../x' }])).toBeNull();
  });
  it('the answer comes from structured output, else the result text', () => {
    expect(worker('debriefAnswerOf', [{ structured_output: { kind: 'none', reason: 'r' } }])).toEqual({ kind: 'none', reason: 'r' });
    expect(worker('debriefAnswerOf', [{ result: 'ok {"kind":"new","reason":"r","folder":"rb-a-b"}' }])).toEqual({ kind: 'new', reason: 'r', folder: 'rb-a-b' });
    expect(worker('debriefAnswerOf', [{ result: 'no json' }])).toBeNull();
  });
  it('the session id comes from the stream', () => {
    const stdout = [JSON.stringify({ type: 'system', subtype: 'init', session_id: SID }), 'junk'].join('\n');
    expect(worker('sessionIdFromStream', [stdout])).toBe(SID);
  });
});
