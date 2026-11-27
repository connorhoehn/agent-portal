// Jest runs CommonJS, and the deck painters' font stack (fontkit and the
// packages it and pdfkit import) ships as ES modules only. Plain Node (and tsx)
// load them through require(esm); jest's module registry cannot, so this turns
// those files, and only those, into CommonJS with esbuild for the test run.
// `import.meta.url` (unicode-properties reads its data file with it) becomes
// the file's URL. The same transform realtime-modules uses for its own jest.
const esbuild = require('esbuild');

module.exports = {
  process(source, filename) {
    const out = esbuild.transformSync(source, {
      format: 'cjs',
      loader: 'js',
      target: 'node20',
      sourcefile: filename,
      define: { 'import.meta.url': '__jestImportMetaUrl' },
      banner: 'var __jestImportMetaUrl = require("url").pathToFileURL(__filename).href;',
    });
    return { code: out.code };
  },
};
