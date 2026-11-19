// Milo's interview tools (milo-tools/index.ts `runMiloTool`): per tool, allowed, refused by permission, refused by its checks,
// and run once; the fallback and acknowledgement lines; and the isolation of the server tools from every other family.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } } }));
import { INTERVIEW_TOOLS, toolsForTenant, VOICE_TENANTS, VOICE_TOOLS } from '../../../voice/catalogue.js';
import { meetingFunctionTools } from '../../../meeting-assistant/instructions.js';
import { DEFAULT_POLICY } from '../../../meeting-assistant/policy.js';
import { MemoryMiloSettingsStore } from '../../milo-settings.js';
import type { MiloPadPlan, MiloPadWriteResult } from '../../pad/milo-writer.js';
import type { PadEventIn } from '../../pad/log/rules.js';
import { MemorySaidStore, setSaidStore, setSpeakDeps } from '../../speak/index.js';
import { MILO_INTRO } from '../../speak/intro.js';
import type { Interview, KitQuestion, PadLanguage } from '../../types.js';
import {
  acknowledgementLine, fallbackLine, HELPER_ADDED, HELPER_NOT_ADDED, INTRO_LEAD_ONLY, NOT_SOLUTION, NOT_STANDARD_IMPORT, NOTHING_NEW, ON_IT,
  notePadChange, PAD_FAILED, PAD_LEAD_ONLY, PAD_NOTE_EVERY_MS, PAD_OFF, resetMiloTools, resetPadNotes, sessionToolsFor, runMiloTool, setMiloToolDeps, TESTS_NOT_ADDED,
} from '../index.js';
import { builtinFor, checkHelper, MAX_HELPER_LINES } from '../helper.js';
import { afterImports, checkedImportLines, placeImports } from '../imports.js';
import { renderTestCases } from '../../testcases/render.js';
import { runInNewContext } from 'node:vm';
import { referenceFor } from '../references.js';
import { INTERVIEW_SCRIPT_RULES, SCRIPTED_LRU_JS, SCRIPTED_SOLUTION_PY, SCRIPTED_TRIE_PY, scriptedTestCases } from '../../../../mock/interviews-testcases.js';

const IV = 'iv-tools';
const LEAD = 'u-hugo';
const PANEL = 'u-wen';
const GUEST = 'guest:inv-mateo';
const TWO_SUM: KitQuestion = {
  id: 'q-be-twosum', competencyId: 'problem-solving', roundType: 'technical', followUps: [],
  prompt: 'Given an array of integers and a target, return the indices of the two numbers that add up to the target.',
  starter: {
    python: 'def two_sum(nums: list[int], target: int) -> list[int]:\n    pass\n\n\nprint(two_sum([2, 7, 11, 15], 9))\n',
    javascript: 'function twoSum(nums, target) {\n}\n\nconsole.log(twoSum([2, 7, 11, 15], 9));\n',
  },
};
const OTHER: KitQuestion = { ...TWO_SUM, id: 'q-no-ref', starter: { python: 'def merge(a, b):\n    pass\n' } };

let interview: Interview;
let pad: { text: string; language: PadLanguage };
let settings: MemoryMiloSettingsStore;
let said: MemorySaidStore;
let logged: PadEventIn[][];
let judged: number;
let verdict: 'helper' | 'solution';
let questions: KitQuestion[];

let failWith: MiloPadWriteResult | null = null;
const write = async (_id: string, plan: MiloPadPlan): Promise<MiloPadWriteResult> => {
  const placement = await plan({ ...pad });
  if (failWith) return failWith;
  const placed = placement ? placement(pad.text) : null;
  if (!placed || !placed.text) return { ok: false, code: 'nothing' };
  pad.text = pad.text.slice(0, placed.index) + placed.text + pad.text.slice(placed.index);
  return { ok: true, from: placed.index, inserted: placed.text.length, length: pad.text.length, lines: placed.text.split('\n').length - 1, language: pad.language, text: pad.text };
};
const cases = (list: Array<{ args: unknown[]; expected?: unknown }>) => list.map((c) => ({ args: JSON.stringify(c.args), expected: JSON.stringify(c.expected ?? null) }));
const dozen = () => cases(scriptedTestCases('q-be-twosum').slice(1, 13));

beforeEach(() => {
  interview = {
    id: IV, leadId: LEAD, panelIds: [PANEL], state: 'live', type: 'technical', callId: 'call-tools', minutes: 60, scheduledAt: new Date().toISOString(),
    questionIds: ['q-be-twosum'], applicationId: 'app-x',
  } as unknown as Interview;
  pad = { text: TWO_SUM.starter!.python!, language: 'python' };
  settings = new MemoryMiloSettingsStore();
  said = new MemorySaidStore(); setSaidStore(said);
  logged = []; judged = 0; verdict = 'helper'; questions = [TWO_SUM]; failWith = null;
  resetMiloTools();
  setSpeakDeps({ callOf: async () => 'call-tools', miloJoinedAt: async () => Date.now() - 10 * 60_000 });
  setMiloToolDeps({
    interview: async (id) => (id === IV ? interview : null),
    guestOf: async (u) => u === GUEST,
    settings: (id) => settings.get(id),
    questions: async () => questions,
    write,
    padLog: async (_id, events) => { logged.push([...events]); return events.length; },
    judge: async () => { judged += 1; return verdict; },
  });
});
afterAll(() => { setMiloToolDeps(null); setSaidStore(null); setSpeakDeps(null); });

const sources = async () => (await said.list(IV)).map((r) => [r.source, r.text, r.posted]);

describe('pad_add_tests', () => {
  it('the lead: twelve checked cases at the bottom of the pad, credited to Milo in the pad log, the line logged unposted', async () => {
    const line = await runMiloTool(IV, LEAD, 'pad_add_tests', { cases: dozen() });
    expect(line).toBe('Added twelve test cases at the bottom of the pad.');
    expect(pad.text).toMatch(/^def two_sum[\s\S]*\n\n# --- Test cases from Milo \(12\) ---\n[\s\S]*milo_test_cases = \[[\s\S]*print\("ok  " if got == expected/);
    expect(logged[0]!.map((e) => e.kind)).toEqual(['tests', 'snapshot']);
    expect(await sources()).toEqual([['tests', line, false]]);
  });

  it('a case the reference disagrees with is dropped, not written', async () => {
    const list = [...scriptedTestCases('q-be-twosum').slice(1, 12), { args: [[1, 2, 3], 5], expected: [0, 1] }];
    expect(await runMiloTool(IV, LEAD, 'pad_add_tests', { cases: cases(list) })).toBe('Added eleven test cases at the bottom of the pad.');
    expect(pad.text).not.toContain('[1, 2, 3]');
    expect(referenceFor('q-be-twosum')!.agrees([[1, 2, 3], 5], [1, 2])).toBe(true);
  });

  it('a question with no reference: inputs only, and Milo says the expected values are theirs to fill in', async () => {
    questions = [OTHER];
    pad.text = OTHER.starter!.python!;
    const line = await runMiloTool(IV, LEAD, 'pad_add_tests', { cases: cases([{ args: [[1], [2]], expected: [1, 2] }]) });
    expect(line).toBe('Added one test input at the bottom of the pad. The expected values are yours to fill in.');
    expect(pad.text).toContain('milo_test_inputs = [');
    expect(pad.text).not.toContain('milo_test_cases');
  });

  it('unreadable cases: one fixed sentence and nothing written', async () => {
    expect(await runMiloTool(IV, LEAD, 'pad_add_tests', { cases: [{ args: 'not json', expected: '1' }] })).toBe(TESTS_NOT_ADDED);
    expect(pad.text).toBe(TWO_SUM.starter!.python!);
  });

  it('the candidate: refused while the lead\'s switch is off; served once it is on; a panel member never', async () => {
    expect(await runMiloTool(IV, GUEST, 'pad_add_tests', { cases: dozen() })).toBe(PAD_OFF);
    expect(pad.text).toBe(TWO_SUM.starter!.python!);
    await settings.setCandidateMayAsk(IV, true, LEAD, new Date().toISOString());
    expect(await runMiloTool(IV, GUEST, 'pad_add_tests', { cases: dozen() })).toMatch(/^Added twelve/);
    expect(await runMiloTool(IV, PANEL, 'pad_add_tests', { cases: dozen() })).toBe(PAD_LEAD_ONLY);
  });
});

describe('pad_add_import', () => {
  it('the lead "for him": the standard-library import at the top, written by the server, once', async () => {
    expect(await runMiloTool(IV, LEAD, 'pad_add_import', { lines: ['from functools import lru_cache'] })).toBe('Added the import at the top of the pad.');
    expect(pad.text.startsWith('from functools import lru_cache\n\ndef two_sum(')).toBe(true);
    expect(logged[0]![0]!.kind).toBe('imports');
    expect(await runMiloTool(IV, LEAD, 'pad_add_import', { lines: ['from functools import lru_cache'] })).toBe(NOTHING_NEW);
  });

  it('refused by its checks: not an import, not the standard library, not the pad\'s language, more than one statement', async () => {
    for (const lines of [['import numpy'], ['import os; os.system("x")'], ['const x = require("lodash")'], ['def two_sum(a, b): return []'], ['from functools import lru_cache  # and more']]) {
      expect(await runMiloTool(IV, LEAD, 'pad_add_import', { lines })).toBe(NOT_STANDARD_IMPORT);
    }
    expect(pad.text).toBe(TWO_SUM.starter!.python!);
    expect(checkedImportLines(['import { readFileSync } from "fs"'], 'typescript')).toEqual(['import { readFileSync } from "node:fs";']);
    expect(placeImports('package main\n\nimport "fmt"\n\nfunc main() {}\n', ['import "sort"'], 'go')).toEqual({ index: 27, text: 'import "sort"\n' });
  });

  it('the candidate needs the switch', async () => {
    expect(await runMiloTool(IV, GUEST, 'pad_add_import', { lines: ['import heapq'] })).toBe(PAD_OFF);
  });
});

describe('pad_add_helper', () => {
  it('the import when the language has one (an LRU cache in Python), the written code when it does not (JavaScript)', async () => {
    expect(builtinFor('an LRU cache', 'python')).toBe('from functools import lru_cache');
    expect(builtinFor('an LRU cache', 'javascript')).toBeNull();
    expect(await runMiloTool(IV, LEAD, 'pad_add_helper', { what: 'an LRU cache', code: SCRIPTED_LRU_JS })).toBe('Added the import at the top of the pad.');
    expect(pad.text.startsWith('from functools import lru_cache\n')).toBe(true);
    pad = { text: TWO_SUM.starter!.javascript!, language: 'javascript' };
    expect(await runMiloTool(IV, LEAD, 'pad_add_helper', { what: 'an LRU cache', code: SCRIPTED_LRU_JS })).toBe(HELPER_ADDED);
    expect(pad.text).toMatch(/^\/\/ --- Added by Milo: an LRU cache ---\nclass LRUCache \{[\s\S]*\n\/\/ --- end of Milo's helper ---\n\nfunction twoSum\(/);
    expect(logged.at(-1)![0]!.kind).toBe('helper');
    expect(judged).toBe(1); // every helper is judged, the lead's too (review 1, item 3)
  });

  it('refuses the question\'s own function, a helper over the size bound, and code in another language', async () => {
    expect(await runMiloTool(IV, LEAD, 'pad_add_helper', { what: 'a helper', code: SCRIPTED_SOLUTION_PY })).toBe(NOT_SOLUTION);
    const long = ['class Big:', ...Array.from({ length: MAX_HELPER_LINES }, (_, i) => `    x${i} = ${i}`)].join('\n');
    expect(checkHelper('a big class', long, 'python', 'two_sum')).toEqual({ ok: false, why: 'size' });
    expect(await runMiloTool(IV, LEAD, 'pad_add_helper', { what: 'a big class', code: long })).toBe(HELPER_NOT_ADDED);
    expect(await runMiloTool(IV, LEAD, 'pad_add_helper', { what: 'an LRU class', code: SCRIPTED_LRU_JS.replace('LRUCache', 'Box') })).toBe('Added the import at the top of the pad.');
    // Code in another language: refused, and the request's run is not used up; the session is told the pad as it is.
    expect(await runMiloTool(IV, LEAD, 'pad_add_helper', { what: 'a box', code: SCRIPTED_LRU_JS.replace('LRUCache', 'Box') })).toMatchObject({ line: HELPER_NOT_ADDED, retry: true, note: expect.stringContaining('It is now in python') });
    expect(pad.text).not.toContain('class Box');
  });

  it('the candidate\'s helper also needs the solution check, which fails closed', async () => {
    await settings.setCandidateMayAsk(IV, true, LEAD, new Date().toISOString());
    verdict = 'solution';
    expect(await runMiloTool(IV, GUEST, 'pad_add_helper', { what: 'a trie', code: SCRIPTED_TRIE_PY })).toBe(NOT_SOLUTION);
    expect(judged).toBe(1);
    expect(pad.text).not.toContain('class Trie');
    verdict = 'helper';
    expect(await runMiloTool(IV, GUEST, 'pad_add_helper', { what: 'a trie', code: SCRIPTED_TRIE_PY })).toBe(HELPER_ADDED);
    expect(pad.text).toMatch(/^# --- Added by Milo: a trie ---\nclass Trie:/);
  });
});

describe('the solution check cannot be gone around (review 1, item 3)', () => {
  it('an alias to the question\'s function is refused like its definition, in Python and JavaScript', () => {
    expect(checkHelper('a pair finder', 'def find_pair(nums, target):\n    return None\n\ntwo_sum = find_pair', 'python', 'two_sum')).toEqual({ ok: false, why: 'entry' });
    expect(checkHelper('a pair finder', 'function findPair(nums, target) {\n  return null;\n}\nconst twoSum = findPair;', 'javascript', 'twoSum')).toEqual({ ok: false, why: 'entry' });
    expect(checkHelper('a counter', 'class Counter:\n    pass', 'python', 'two_sum')).toMatchObject({ ok: true });
  });

  it('a solution in comments goes to the verdict even when the lead asks, and is refused', async () => {
    verdict = 'solution';
    const commented = 'class Box:\n    # for each n: if target - n was seen, return both indices\n    pass';
    expect(await runMiloTool(IV, LEAD, 'pad_add_helper', { what: 'a box', code: commented })).toBe(NOT_SOLUTION);
    expect(judged).toBe(1);
    expect(pad.text).not.toContain('class Box');
  });

  it('no question to judge by (none in the kit, or the read failed): the helper is refused, fail closed', async () => {
    questions = [];
    expect(await runMiloTool(IV, LEAD, 'pad_add_helper', { what: 'a trie', code: SCRIPTED_TRIE_PY })).toBe(HELPER_NOT_ADDED);
    expect(judged).toBe(0);
    expect(pad.text).not.toContain('class Trie');
  });

  it('cases with a long string go to the verdict; refused when it says solution or there is no question', async () => {
    questions = [OTHER];
    pad.text = OTHER.starter!.python!;
    const story = 'walk the list keeping a map of each value seen to its index';
    verdict = 'solution';
    expect(await runMiloTool(IV, LEAD, 'pad_add_tests', { cases: cases([{ args: [story], expected: 1 }]) })).toBe(TESTS_NOT_ADDED);
    expect(judged).toBe(1);
    expect(pad.text).not.toContain(story);
    verdict = 'helper';
    expect(await runMiloTool(IV, LEAD, 'pad_add_tests', { cases: cases([{ args: ['short words'], expected: 1 }]) })).toMatch(/^Added one test input/);
    expect(judged).toBe(1); // a short string needs no verdict
    questions = [{ ...OTHER, prompt: '' }];
    expect(await runMiloTool(IV, LEAD, 'pad_add_tests', { cases: cases([{ args: [`${story} again`], expected: 1 }]) })).toBe(TESTS_NOT_ADDED);
  });
});

describe('nothing Milo writes breaks the pad (review 1, item 4)', () => {
  it('two batches of cases in a JavaScript pad both run: each block is its own scope', () => {
    const fn = 'function twoSum(nums, target) { return [0, 1]; }\n';
    const one = renderTestCases([{ args: [[1, 2], 3], expected: [0, 1] }], 'javascript', 'twoSum');
    const two = renderTestCases([{ args: [[3, 4], 7], expected: [0, 1] }], 'javascript', 'twoSum');
    const printed: string[] = [];
    expect(() => runInNewContext(`${fn}\n${one}\n${two}`, { console: { log: (...a: unknown[]) => printed.push(a.join(' ')) }, JSON })).not.toThrow();
    expect(printed.filter((l) => l.startsWith('ok'))).toHaveLength(2);
    const ts = renderTestCases([{ args: [[1, 2], 3] }], 'typescript', 'twoSum');
    expect(ts.split('\n').filter((l) => l === '{' || l === '}')).toEqual(['{', '}']);
  });

  it('a write that failed after typing part of the block is logged as Milo\'s attempt, taken out again', async () => {
    failWith = { ok: false, code: 'timeout', typed: { from: 10, inserted: 40, lines: 3, removed: true, length: 50, language: 'python', text: 'x'.repeat(50) } };
    expect(await runMiloTool(IV, LEAD, 'pad_add_tests', { cases: dozen() })).toBe(PAD_FAILED);
    expect(logged.at(-1)![0]).toMatchObject({ kind: 'tests', from: 10, inserted: 40, deleted: 40, lines: 3 });
    expect(logged.at(-1)![1]).toMatchObject({ kind: 'snapshot', length: 50 });
  });

  it('imports go after a bracketed import group, never inside it: Go, Python and TypeScript', () => {
    const go = 'package main\n\nimport (\n\t"fmt"\n\t"strings"\n)\n\nfunc main() {}\n';
    expect(go.slice(0, afterImports(go, 'go'))).toBe('package main\n\nimport (\n\t"fmt"\n\t"strings"\n)\n');
    const py = 'from typing import (\n    List,\n    Dict,\n)\nimport os\n\ndef two_sum(nums, target):\n    pass\n';
    expect(py.slice(0, afterImports(py, 'python'))).toBe('from typing import (\n    List,\n    Dict,\n)\nimport os\n');
    const ts = "import {\n  readFileSync,\n  writeFileSync,\n} from 'node:fs';\n\nfunction twoSum() {}\n";
    expect(ts.slice(0, afterImports(ts, 'typescript'))).toBe("import {\n  readFileSync,\n  writeFileSync,\n} from 'node:fs';\n");
    // A group never closed: placed before it, not inside.
    const open = 'import os\nfrom typing import (\n    List,\n';
    expect(open.slice(0, afterImports(open, 'python'))).toBe('import os\n');
    expect(placeImports(go, ['import "sort"'], 'go')!.index).toBe(go.indexOf(')\n') + 2);
  });
});

describe('the session hears the pad change (review 1, item 7)', () => {
  const contexts: Array<[string, string]> = [];
  beforeEach(() => { contexts.length = 0; resetPadNotes(); });
  const runtimeWith = async () => {
    const orchestrator = await import('../../../meeting-assistant/orchestrator.js');
    return jest.spyOn(orchestrator, 'peekAssistantRuntime').mockReturnValue({ addSessionContext: (c: string, t: string) => { contexts.push([c, t]); return true; } } as never);
  };

  it('a language change is told at once with the pad text now; a text change at most every PAD_NOTE_EVERY_MS', async () => {
    const spy = await runtimeWith();
    try {
      interview = { ...interview, callId: 'call-tools' } as Interview;
      await sessionToolsFor(IV); // the session starts with the Python pad
      const t0 = Date.now();
      expect(await notePadChange(IV, [{ kind: 'language', clientAt: new Date(t0).toISOString(), language: 'javascript' }], t0)).toBe(true);
      expect(contexts.at(-1)![0]).toBe('call-tools');
      expect(contexts.at(-1)![1]).toContain('It is now in javascript');
      const snap = (text: string) => [{ kind: 'snapshot' as const, clientAt: new Date(t0).toISOString(), text, language: 'javascript' }];
      expect(await notePadChange(IV, snap('function twoSum() {}'), t0 + 1000)).toBe(false); // too soon after the last note
      expect(await notePadChange(IV, snap('function twoSum() { return 1; }'), t0 + PAD_NOTE_EVERY_MS + 1)).toBe(true);
      expect(contexts.at(-1)![1]).toContain('return 1;');
      expect(await notePadChange(IV, snap('function twoSum() { return 1; }'), t0 + 3 * PAD_NOTE_EVERY_MS)).toBe(false); // unchanged
    } finally { spy.mockRestore(); }
  });
});

describe('introduce, time_left, repeat_question', () => {
  it('introduce: the lead only, once an interview', async () => {
    expect(await runMiloTool(IV, GUEST, 'introduce', {})).toBe(INTRO_LEAD_ONLY);
    expect(await runMiloTool(IV, LEAD, 'introduce', {})).toBe(MILO_INTRO);
    resetMiloTools();
    expect(await runMiloTool(IV, LEAD, 'introduce', {})).toBeNull();
  });

  it('time_left: anyone; the same request heard twice (the phrase and the model\'s call) runs once', async () => {
    expect(await runMiloTool(IV, GUEST, 'time_left', {})).toMatch(/minute/);
    expect(await runMiloTool(IV, GUEST, 'time_left', {})).toBeNull();
    expect(await runMiloTool(IV, GUEST, 'repeat_question', {})).toBe('Milo has not asked a question yet.');
  });

  it('nothing for a stranger, an unknown tool, or an interview that is not live', async () => {
    expect(await runMiloTool(IV, 'u-stranger', 'time_left', {})).toBeNull();
    expect(await runMiloTool(IV, LEAD, 'create', {})).toBeNull();
    interview = { ...interview, state: 'ended' } as Interview;
    expect(await runMiloTool(IV, LEAD, 'pad_add_tests', { cases: dozen() })).toBeNull();
  });
});

describe('the fallback and the acknowledgement', () => {
  it('a request nothing served: what THIS asker may ask; the candidate without pad help their own sentence; a panel member nothing', async () => {
    expect(await fallbackLine(IV, LEAD, 'CANDIDATE')).toMatch(/^I can add test cases, imports or a helper to the pad, introduce myself/);
    expect(await fallbackLine(IV, GUEST, 'CANDIDATE')).toBe('CANDIDATE');
    await settings.setCandidateMayAsk(IV, true, LEAD, new Date().toISOString());
    expect(await fallbackLine(IV, GUEST, 'CANDIDATE')).toMatch(/^I can repeat the question, tell you how much time is left, or add test cases/);
    expect(await fallbackLine(IV, PANEL, 'CANDIDATE')).toBeNull();
  });

  it('"On it." for a slow pad request from someone allowed; never for an import or a refused asker', async () => {
    expect(await acknowledgementLine(IV, LEAD, 'it would be helpful to have another dozen test cases')).toBe(ON_IT);
    expect(await acknowledgementLine(IV, LEAD, 'add the import for him at the top')).toBeNull();
    expect(await acknowledgementLine(IV, GUEST, 'can I have some test cases')).toBeNull();
    expect((await said.list(IV)).map((r) => r.source)).toEqual(['ack']);
  });
});

describe('the scripted stand-in and the isolation of the server tools', () => {
  it('the scripted rules carry fixed arguments for both owner examples', () => {
    const rule = (t: string) => INTERVIEW_SCRIPT_RULES.find((r) => r.match.test(t));
    const step = rule('it would be helpful to have another dozen test cases')!;
    const m = step.match.exec('it would be helpful to have another dozen test cases')!;
    const out = step.run(m) as { call: { name: string; args: { cases: unknown[] } } };
    expect([out.call.name, out.call.args.cases.length]).toEqual(['pad_add_tests', 12]);
    const lru = rule('Mateo wants to use an LRU cache for his algorithm, can you just add it for him at the top')!;
    expect((lru.run(lru.match.exec('an LRU cache')!) as { call: { name: string } }).call.name).toBe('pad_add_helper');
  });

  it('no other family is offered them: not in VOICE_TOOLS, not in any navigator tenant, not in Work\'s call tools', () => {
    const names = INTERVIEW_TOOLS.map((t) => t.name);
    expect(INTERVIEW_TOOLS.every((t) => t.kind === 'server' && t.tenants.join() === 'interviews')).toBe(true);
    expect(VOICE_TOOLS.map((t) => t.name).filter((n) => names.includes(n))).toEqual([]);
    expect((VOICE_TENANTS as readonly string[]).includes('interviews')).toBe(false);
    for (const tenant of [...VOICE_TENANTS, 'interviews']) {
      expect(toolsForTenant(tenant).map((t) => t.name).filter((n) => names.includes(n))).toEqual([]);
      expect(meetingFunctionTools(tenant).map((t) => t.name).filter((n) => names.includes(n))).toEqual([]);
    }
    // The inventory (scripts/voice/inventory.mjs, docs/voice-tool-inventory.json) lists them as server tools, with who may ask.
    const inventory = JSON.parse(readFileSync(join(__dirname, '../../../../../../docs/voice-tool-inventory.json'), 'utf8')) as { serverTools: Array<{ name: string; who: string; kind: string }> };
    expect(inventory.serverTools.map((t) => [t.name, t.who, t.kind])).toEqual(INTERVIEW_TOOLS.map((t) => [t.name, t.who, 'server']));
    const work = DEFAULT_POLICY.sessionTools({ callId: 'c', lobby: 'orgiq:initiative:x', tenant: 'orgiq' });
    expect(('tools' in work ? work.tools : []).map((t) => t.name).filter((n) => names.includes(n))).toEqual([]);
  });
});
