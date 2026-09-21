// Fold a prototype build into ONE .html file.
//
// A prototype's whole job is to be looked at and argued with, and that means
// somebody has to be able to open it from a file path or send it to a
// colleague. Vite emits an HTML file plus an entry chunk plus a stylesheet, and
// a `<script src>` next to a `file://` page is a cross-origin module — the
// browser refuses it and the page renders blank. So the chunk and the sheet go
// inline and the rest is deleted.
//
// Everything else is already inlined by the config's enormous
// `assetsInlineLimit`, so there is nothing here about fonts or images.
//
//   node prototypes/inline.mjs [outDir]

import { readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? join(here, 'active-now', 'build'));
const htmlPath = join(outDir, 'index.html');
if (!existsSync(htmlPath)) {
  console.error(`No build at ${htmlPath} — run the build first.`);
  process.exit(1);
}

let html = readFileSync(htmlPath, 'utf8');
const assetDir = join(outDir, 'assets');
const assets = existsSync(assetDir) ? readdirSync(assetDir) : [];

for (const file of assets) {
  const body = readFileSync(join(assetDir, file), 'utf8');
  if (file.endsWith('.js')) {
    // A `</script` sequence anywhere in the bundle closes the tag it is being
    // embedded in — HTML ends script data at `</script` followed by whitespace,
    // `/` or `>`, so matching the full `</script>` is not enough and misses
    // most of them (this bundle carries seven). `<\/script` is the standard
    // escape: identical inside a JS string or regex, and `</script` cannot
    // legally appear anywhere else in parseable JavaScript.
    const safe = body.replace(/<\/script/gi, '<\\/script');
    // A replacer FUNCTION, never a replacement string. In a string, `$&`, `$'`
    // and `` $` `` are substitution patterns — and minified JavaScript is full
    // of `$` — so a string replacement silently splices parts of the document
    // back into the bundle. That is what "missing ) after argument list" and a
    // page of source code rendered as body text turned out to be.
    html = html.replace(
      new RegExp(`<script[^>]*src="[^"]*${file}"[^>]*></script>`),
      () => `<script type="module">${safe}</script>`,
    );
  } else if (file.endsWith('.css')) {
    html = html.replace(
      new RegExp(`<link[^>]*href="[^"]*${file}"[^>]*>`),
      () => `<style>${body}</style>`,
    );
  }
}

writeFileSync(htmlPath, html);
rmSync(assetDir, { recursive: true, force: true });

const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(`Single file: ${htmlPath} (${kb} KB)`);

// Check the DOCUMENT's own tags, not the text of what was just embedded in
// them. Vite's modulepreload helper contains the string `link[rel=
// "modulepreload"]` and the bundle carries its own asset path, so scanning the
// whole file reports a failure on a correctly inlined page every time.
const markup = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');
if (/<script[^>]*\ssrc=|<link[^>]*rel="stylesheet"/i.test(markup)) {
  console.error('An external reference survived — the file will not open standalone.');
  process.exit(1);
}
