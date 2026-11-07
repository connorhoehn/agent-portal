/** Pure CLI parsing shared by the launcher and regression fixtures. */
export const usage = 'Usage: node audit.mjs --project <frontend package directory> --adapter <adapter.ts> --out <directory> [--tenant id] [--path exact-route-or-substring] [--all] [--themes light,dark] [--widths 1440,900] [--states default|all] [--contract contract.json] [--previous report.json] [--no-screenshots] [--strict-coverage] [--deep] [--review] [--deep-states layers,tabs,focus,data] [--data-modes empty,error,loading,long,many,denied] [--deep-layers 5]';
export function parseAuditArgs(args) {
  const options = {};
  const flags = { '--all': ['all', true], '--no-screenshots': ['screenshots', false], '--strict-coverage': ['strictCoverage', true], '--deep': ['deep', true], '--review': ['review', true] };
  const values = new Set(['adapter', 'project', 'out', 'tenant', 'path', 'themes', 'widths', 'previous', 'states', 'contract']);
  const named = { 'deep-states': 'deepStates', 'data-modes': 'dataModes', 'deep-layers': 'deepLayers' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (Object.hasOwn(flags, arg)) { const [key, value] = flags[arg]; options[key] = value; continue; }
    const raw = arg.startsWith('--') ? arg.slice(2) : '';
    if (named[raw] && args[i + 1] && !args[i + 1].startsWith('--')) { options[named[raw]] = named[raw] === 'deepLayers' ? Number(args[++i]) : args[++i]; continue; }
    const key = raw;
    if (!values.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown/missing argument: ' + arg);
    options[key] = args[++i];
  }
  if (!options.adapter || !options.project || !options.out) throw new Error(usage);
  if (options.states && !['default', 'all'].includes(options.states)) throw new Error('--states must be default or all');
  // A deep pass captures every case for the visual review (deep-audit.md).
  if (options.deep && options.review === undefined) options.review = true;
  if (options.deepStates && options.deepStates.split(',').some(x => !['layers', 'tabs', 'focus', 'data'].includes(x))) throw new Error('--deep-states takes layers,tabs,focus,data');
  return options;
}
