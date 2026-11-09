// When the Chromium build the installed Playwright expects is missing but another
// build of the same browser is installed, point Playwright at a shim directory
// whose expected build names link to the installed ones, and say so.
//
// Playwright looks a browser up by its exact revision
// (`<PLAYWRIGHT_BROWSERS_PATH>/chromium_headless_shell-<rev>/…`). A
// `@playwright/test` bump changes the revision while the machine still holds the
// previous download, and installing a browser is a network step an offline run
// cannot take, so the audit died with "Executable doesn't exist" (walk,
// 9 November: build 1223 wanted, 1248 installed). The fallback never downloads
// anything and never touches the real cache: it only adds links under `shimDir`.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The cache Playwright reads when PLAYWRIGHT_BROWSERS_PATH is unset. */
function defaultBrowsersPath(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'ms-playwright');
}

/** Playwright's directory prefix for a browsers.json name (`chromium-headless-shell` → `chromium_headless_shell`). */
const dirPrefix = (name) => name.replace(/-/g, '_');

/** The highest installed revision of `name` in `cache` with a finished install, or null. */
function installedRevision(cache, name) {
  let entries = [];
  try { entries = fs.readdirSync(cache); } catch { return null; }
  const prefix = `${dirPrefix(name)}-`;
  const revisions = entries
    .filter((e) => e.startsWith(prefix) && /^\d+$/.test(e.slice(prefix.length)))
    .filter((e) => fs.existsSync(path.join(cache, e, 'INSTALLATION_COMPLETE')))
    .map((e) => Number(e.slice(prefix.length)))
    .sort((a, b) => b - a);
  return revisions.length ? String(revisions[0]) : null;
}

/**
 * Plan the fallback. `wanted` is browsers.json's `browsers` (name + revision);
 * only the Chromium builds the audit launches are considered. Returns
 * `{ substitutions: [{ name, wanted, installed }], missing: [name] }`; nothing to
 * do when both are empty.
 */
function planFallback(wanted, cache) {
  const substitutions = [];
  const missing = [];
  for (const b of wanted) {
    if (b.name !== 'chromium' && b.name !== 'chromium-headless-shell') continue;
    if (fs.existsSync(path.join(cache, `${dirPrefix(b.name)}-${b.revision}`, 'INSTALLATION_COMPLETE'))) continue;
    const installed = installedRevision(cache, b.name);
    if (installed) substitutions.push({ name: b.name, wanted: b.revision, installed });
    else missing.push(b.name);
  }
  return { substitutions, missing };
}

/**
 * Build the shim: every entry of the real cache linked by name, plus each
 * substitution's wanted name linked to the installed build. Returns the env
 * patch (`{ PLAYWRIGHT_BROWSERS_PATH }`) and the lines to print, or null when
 * the expected builds are installed (nothing changes).
 */
function applyFallback({ projectDir, shimDir, env = process.env, log = console.error }) {
  let manifest;
  try {
    const core = require.resolve('playwright-core/package.json', { paths: [projectDir] });
    manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(core), 'browsers.json'), 'utf8'));
  } catch {
    return null; // No Playwright here: the runner reports that itself.
  }
  const cache = env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0' ? env.PLAYWRIGHT_BROWSERS_PATH : defaultBrowsersPath();
  const plan = planFallback(manifest.browsers ?? [], cache);
  if (plan.missing.length) {
    log(`ui-dom-audit: no ${plan.missing.join(' or ')} build is installed in ${cache}; install one with \`npx playwright install chromium\` (a network step).`);
  }
  if (plan.substitutions.length === 0) return null;
  fs.rmSync(shimDir, { recursive: true, force: true });
  fs.mkdirSync(shimDir, { recursive: true });
  for (const entry of fs.readdirSync(cache)) fs.symlinkSync(path.join(cache, entry), path.join(shimDir, entry));
  for (const s of plan.substitutions) {
    const link = path.join(shimDir, `${dirPrefix(s.name)}-${s.wanted}`);
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(path.join(cache, `${dirPrefix(s.name)}-${s.installed}`), link);
    log(`ui-dom-audit: Playwright wants ${s.name} build ${s.wanted}, which is not installed; using the installed build ${s.installed} instead (links in ${shimDir}). Run \`npx playwright install chromium\` to get ${s.wanted}.`);
  }
  return { PLAYWRIGHT_BROWSERS_PATH: shimDir };
}

module.exports = { applyFallback, defaultBrowsersPath, installedRevision, planFallback };
