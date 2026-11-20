import { spawnSync } from 'node:child_process';

/** Read the executable case list from the full saved pad, never the editor's visible rows. */
export function pythonTestCases(source) {
  const program = `import ast,json,sys
tree=ast.parse(sys.stdin.read())
cases=[]
checked=False
for node in tree.body:
 if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='milo_test_cases' for t in node.targets):
  cases=ast.literal_eval(node.value)
 if isinstance(node,ast.Assert):
  checked=checked or ast.dump(node.test)==ast.dump(ast.parse('milo_failures == 0',mode='eval').body)
print(json.dumps({'cases':cases,'checked':checked}))`;
  const result = spawnSync('python3', ['-c', program], { input: source, encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) return { ok: false, cases: [], empty: false, duplicates: false };
  const { cases, checked } = JSON.parse(result.stdout);
  const empty = cases.some(([args, expected]) => Array.isArray(args[0]) && args[0].length === 0 && Array.isArray(expected) && expected.length === 0);
  const duplicates = cases.some(([args, expected]) => Array.isArray(args[0]) && new Set(args[0]).size < args[0].length
    && Array.isArray(expected) && expected.length === 2 && expected[0] !== expected[1]);
  return { ok: empty && duplicates && checked, cases, empty, duplicates };
}

export function passingRun(output, count) {
  return /Finished/i.test(output) && /Exit code 0\b/.test(output)
    && !/\bDIFF\b|AssertionError|Traceback|Error:/.test(output)
    && [...output.matchAll(/\bok\s+\(/g)].length === count;
}
