#!/usr/bin/env node
// Build a disposable production bundle and report rendered module attribution.
// This observes the existing split and warning threshold; it does not alter them.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portal = path.join(root, 'portal');
const require = createRequire(path.join(portal, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const out = path.resolve(root, process.argv[2] ?? '.scratch/portal-bundle-profile');
if (!out.startsWith(path.join(root, '.scratch/'))) throw new Error('Profile output must be in this checkout’s .scratch directory.');
let report;
await build({ root: portal, configFile: path.join(portal, 'vite.config.ts'), build: { outDir: path.join(out, 'dist') }, plugins: [{
  name: 'report-rendered-module-cost',
  generateBundle(_options, bundle) {
    const chunks = Object.values(bundle).filter(item => item.type === 'chunk').map(chunk => ({
      file: chunk.fileName, entry: chunk.isEntry, bytes: Buffer.byteLength(chunk.code), gzipBytes: gzipSync(chunk.code).length,
      imports: chunk.imports, dynamicImports: chunk.dynamicImports,
      modules: Object.entries(chunk.modules).map(([id, module]) => ({ id: id.replace(root + '/', '').replaceAll('\0', ''), renderedBytes: module.renderedLength })).sort((a,b) => b.renderedBytes - a.renderedBytes),
    })).sort((a,b) => b.bytes-a.bytes);
    const initial = new Set();
    function visit(file) { if (initial.has(file)) return; initial.add(file); chunks.find(c=>c.file===file)?.imports.forEach(visit); }
    chunks.filter(c=>c.entry).forEach(c=>visit(c.file));
    report = { generatedAt: new Date().toISOString(), attribution: 'rendered module bytes before chunk minification; gzip measured per emitted chunk, not additive network compression', initialChunks: chunks.filter(c=>initial.has(c.file)).map(c=>c.file), initialBytes: chunks.filter(c=>initial.has(c.file)).reduce((n,c)=>n+c.bytes,0), chunks };
  },
}] });
await fs.mkdir(out,{recursive:true});
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ initialBytes: report.initialBytes, initialChunks: report.initialChunks, largest: report.chunks.slice(0,5).map(({modules,...chunk})=>chunk) },null,2));
