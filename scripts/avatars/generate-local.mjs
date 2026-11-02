#!/usr/bin/env node
// Maintain local avatar assets and derived photo indexes for the mock cast.
//
//   node scripts/avatars/generate-local.mjs          # write portal/public/avatars/
//   node scripts/avatars/generate-local.mjs --check  # exit 1 if the files on disk differ
//
// Photo selection comes from photos/personas.json and is shared by the portal
// and middleware. This script validates commissioned assets; it never generates
// or substitutes a photographic identity. The deterministic SVGs below remain
// as legacy assets only and are not selected by the app.
//
// Who gets one: every person in the mock org fixture
// (middleware/src/mock/people.ts `seededPeople`, the p-NNN cast) and every
// app user without a linked person (middleware/src/providers/identity.ts
// FALLBACK_USERS rows with `personId: null`). A linked user shows their
// person's face, so they get no file of their own.
//
// Every choice — face shape, skin and hair palette, hair style, glasses,
// earrings, beard, expression, background — is read from a sha256 of the id,
// so a rerun writes byte-identical files and a new person never reshuffles an
// existing one. Shapes are deliberately bold (no thin detail carries the
// likeness) so a face still reads at 24px, and the eyes/mouth carry enough
// line weight to read at 96px.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'portal', 'public', 'avatars');
const PEOPLE_SRC = join(ROOT, 'middleware', 'src', 'mock', 'people.ts');
const USERS_SRC = join(ROOT, 'middleware', 'src', 'providers', 'identity.ts');
const PHOTO_MANIFEST = join(OUT_DIR, 'photos', 'personas.json');

// ── Cast ─────────────────────────────────────────────────────────────────────

function unquote(s) {
  return s.replace(/\\'/g, "'");
}

/** p-NNN rows (and the access cast's p-<name> rows) of `seededPeople` (the fixture, not the `large` clones). */
function readPeople() {
  const src = readFileSync(PEOPLE_SRC, 'utf8');
  const start = src.indexOf('export const seededPeople');
  const end = src.indexOf('];', start);
  if (start < 0 || end < 0) throw new Error(`seededPeople not found in ${PEOPLE_SRC}`);
  const block = src.slice(start, end);
  const re = /\{ id: '(p-[a-z0-9]+)', name: '((?:[^'\\]|\\.)*)'/g;
  const out = [];
  for (let m; (m = re.exec(block));) out.push({ id: m[1], name: unquote(m[2]), kind: 'person' });
  if (out.length === 0) throw new Error('seededPeople parsed to zero rows');
  return out;
}

/** FALLBACK_USERS rows with no linked person. */
function readUnlinkedUsers() {
  const src = readFileSync(USERS_SRC, 'utf8');
  const start = src.indexOf('const FALLBACK_USERS');
  const end = src.indexOf('];', start);
  if (start < 0 || end < 0) throw new Error(`FALLBACK_USERS not found in ${USERS_SRC}`);
  const block = src.slice(start, end);
  const re = /\{ id: '(u-[a-z0-9-]+)', displayName: '((?:[^'\\]|\\.)*)', email: [^,]+, personId: (null|'p-\d+')/g;
  const out = [];
  for (let m; (m = re.exec(block));) {
    if (m[3] === 'null') out.push({ id: m[1], name: unquote(m[2]), kind: 'user' });
  }
  if (out.length === 0) throw new Error('FALLBACK_USERS parsed to zero unlinked users');
  return out;
}

// ── Deterministic choice ─────────────────────────────────────────────────────

/** A stream of bytes from sha256(id), extended by re-hashing when exhausted. */
function chooser(id) {
  let buf = createHash('sha256').update(`orgiq-avatar-v1:${id}`).digest();
  let i = 0;
  const byte = () => {
    if (i >= buf.length) { buf = createHash('sha256').update(buf).digest(); i = 0; }
    return buf[i++];
  };
  return {
    pick: (list) => list[(byte() * 256 + byte()) % list.length],
    chance: (p) => byte() / 255 < p,
    range: (lo, hi) => lo + (byte() / 255) * (hi - lo),
  };
}

// ── Palettes (one consistent set: muted flat illustration) ───────────────────

const BACKGROUNDS = ['#dbeafe', '#e0e7ff', '#ede9fe', '#fae8ff', '#fce7f3', '#ffe4e6', '#fef3c7', '#ecfccb', '#d1fae5', '#ccfbf1', '#cffafe', '#e2e8f0'];
const SKIN = [
  { base: '#f9d7c3', shade: '#e8b9a0' },
  { base: '#f1c27d', shade: '#d9a45f' },
  { base: '#e0ac69', shade: '#c48f4f' },
  { base: '#c68642', shade: '#a86e33' },
  { base: '#a0662f', shade: '#845226' },
  { base: '#8d5524', shade: '#71431c' },
  { base: '#6b3f1f', shade: '#553118' },
  { base: '#f5cfa0', shade: '#dfb07c' },
];
const HAIR = ['#1f1a17', '#2e2320', '#4a3122', '#6b4226', '#8c5a2b', '#b5772f', '#d9a94f', '#a33a1f', '#7a7a7a', '#d6d3d1', '#3b2f5c', '#1e3a5f'];
const SHIRT = ['#2563eb', '#7c3aed', '#0891b2', '#059669', '#dc2626', '#ea580c', '#475569', '#0f766e', '#be185d', '#4338ca'];
const INK = '#1f2937';

const FACE_SHAPES = ['round', 'oval', 'soft-square'];
const HAIR_STYLES = ['crop', 'side-part', 'long', 'bob', 'curly', 'bun', 'buzz', 'bald', 'ponytail', 'afro', 'swoop'];
const EXPRESSIONS = ['smile', 'grin', 'calm', 'smirk'];
const GLASSES = [null, null, null, 'round', 'square'];

// ── Drawing (viewBox 0 0 96 96) ──────────────────────────────────────────────

function face(shape, skin) {
  switch (shape) {
    case 'oval': return `<ellipse cx="48" cy="46" rx="19" ry="23" fill="${skin.base}"/>`;
    case 'soft-square': return `<rect x="29" y="24" width="38" height="44" rx="15" fill="${skin.base}"/>`;
    default: return `<ellipse cx="48" cy="47" rx="21" ry="22" fill="${skin.base}"/>`;
  }
}

/** Hair drawn BEHIND the head (long styles), then hair drawn in FRONT. */
function hair(style, color) {
  const back = {
    long: `<path d="M24 44 Q24 18 48 18 Q72 18 72 44 L74 80 L22 80 Z" fill="${color}"/>`,
    bob: `<path d="M25 46 Q25 19 48 19 Q71 19 71 46 L71 62 Q60 66 48 66 Q36 66 25 62 Z" fill="${color}"/>`,
    ponytail: `<circle cx="72" cy="36" r="9" fill="${color}"/>`,
    afro: `<circle cx="48" cy="38" r="29" fill="${color}"/>`,
    curly: [[30, 32], [38, 24], [48, 21], [58, 24], [66, 32], [27, 42], [69, 42]]
      .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="8" fill="${color}"/>`).join(''),
  }[style] ?? '';
  const front = {
    crop: `<path d="M28 42 Q28 22 48 22 Q68 22 68 42 Q62 32 48 31 Q34 32 28 42 Z" fill="${color}"/>`,
    'side-part': `<path d="M27 44 Q26 20 50 21 Q70 22 69 42 Q60 30 44 31 Q36 33 27 44 Z" fill="${color}"/>`,
    long: `<path d="M27 46 Q28 22 48 22 Q68 22 69 46 Q62 30 48 30 Q36 30 27 46 Z" fill="${color}"/>`,
    bob: `<path d="M27 46 Q28 22 48 22 Q68 22 69 46 Q66 34 56 31 Q44 36 27 46 Z" fill="${color}"/>`,
    curly: '',
    bun: `<circle cx="48" cy="17" r="8" fill="${color}"/><path d="M28 42 Q28 22 48 22 Q68 22 68 42 Q62 31 48 30 Q34 31 28 42 Z" fill="${color}"/>`,
    buzz: `<path d="M29 40 Q29 23 48 23 Q67 23 67 40 Q60 31 48 31 Q36 31 29 40 Z" fill="${color}" opacity="0.75"/>`,
    bald: '',
    ponytail: `<path d="M28 42 Q28 22 48 22 Q68 22 68 42 Q60 30 48 30 Q36 30 28 42 Z" fill="${color}"/>`,
    afro: '',
    swoop: `<path d="M27 44 Q24 20 48 20 Q72 20 69 40 Q58 26 40 34 Q32 38 27 44 Z" fill="${color}"/>`,
  }[style] ?? '';
  return { back, front };
}

function eyes(glasses) {
  const lids = `<circle cx="40" cy="46" r="2.6" fill="${INK}"/><circle cx="56" cy="46" r="2.6" fill="${INK}"/>`;
  const brows = `<path d="M35 40 Q40 37.5 44 40" stroke="${INK}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`
    + `<path d="M52 40 Q56 37.5 61 40" stroke="${INK}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`;
  let frames = '';
  if (glasses === 'round') {
    frames = `<g stroke="${INK}" stroke-width="2" fill="none"><circle cx="40" cy="46" r="6"/><circle cx="56" cy="46" r="6"/><path d="M46 46 L50 46"/></g>`;
  } else if (glasses === 'square') {
    frames = `<g stroke="${INK}" stroke-width="2" fill="none"><rect x="33.5" y="41" width="13" height="10" rx="2.5"/><rect x="49.5" y="41" width="13" height="10" rx="2.5"/><path d="M46.5 46 L49.5 46"/></g>`;
  }
  return lids + brows + frames;
}

function mouth(expression) {
  switch (expression) {
    case 'grin': return `<path d="M40 56 Q48 64 56 56 Z" fill="${INK}"/><path d="M42 57 Q48 59 54 57" stroke="#ffffff" stroke-width="1.4" fill="none"/>`;
    case 'calm': return `<path d="M42 58 Q48 60 54 58" stroke="${INK}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
    case 'smirk': return `<path d="M42 58 Q50 61 55 55.5" stroke="${INK}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
    default: return `<path d="M41 56 Q48 62 55 56" stroke="${INK}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
  }
}

function avatarSvg(person) {
  const c = chooser(person.id);
  const bg = c.pick(BACKGROUNDS);
  const skin = c.pick(SKIN);
  const hairColor = c.pick(HAIR);
  const shirt = c.pick(SHIRT);
  const shape = c.pick(FACE_SHAPES);
  const style = c.pick(HAIR_STYLES);
  const expression = c.pick(EXPRESSIONS);
  const glasses = c.pick(GLASSES);
  const earrings = c.chance(0.25);
  const beard = !['long', 'bob', 'bun', 'ponytail'].includes(style) && c.chance(0.3);
  const blush = c.chance(0.5);
  const h = hair(style, hairColor);

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96" role="img" aria-label="Illustrated avatar">`,
    `<circle cx="48" cy="48" r="48" fill="${bg}"/>`,
    `<clipPath id="c"><circle cx="48" cy="48" r="48"/></clipPath>`,
    `<g clip-path="url(#c)">`,
    h.back,
    // Shoulders, then neck, so the collar sits over the neck's base.
    `<path d="M12 98 Q14 74 36 70 L60 70 Q82 74 84 98 Z" fill="${shirt}"/>`,
    `<rect x="41" y="60" width="14" height="14" rx="5" fill="${skin.shade}"/>`,
    `<path d="M40 70 L48 78 L56 70" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="2"/>`,
    // Ears sit just outside the face.
    `<circle cx="28" cy="48" r="4.5" fill="${skin.shade}"/><circle cx="68" cy="48" r="4.5" fill="${skin.shade}"/>`,
    earrings ? `<circle cx="28" cy="54" r="1.8" fill="#facc15"/><circle cx="68" cy="54" r="1.8" fill="#facc15"/>` : '',
    face(shape, skin),
    beard ? `<path d="M30 50 Q32 70 48 71 Q64 70 66 50 Q62 62 48 62 Q34 62 30 50 Z" fill="${hairColor}"/>` : '',
    h.front,
    blush ? `<circle cx="35" cy="54" r="3" fill="#f43f5e" opacity="0.18"/><circle cx="61" cy="54" r="3" fill="#f43f5e" opacity="0.18"/>` : '',
    eyes(glasses),
    `<path d="M48 48 Q46 52 48.5 53" stroke="${skin.shade}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
    mouth(expression),
    `</g>`,
    `</svg>`,
  ];
  return parts.filter(Boolean).join('') + '\n';
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const check = process.argv.includes('--check');
  const cast = [...readPeople(), ...readUnlinkedUsers()];
  const ids = new Set();
  for (const p of cast) {
    if (ids.has(p.id)) throw new Error(`duplicate avatar id ${p.id}`);
    ids.add(p.id);
  }

  // Photograph selection is durable: regenerating the fallback SVGs must
  // never put a cartoon back on a commissioned demo persona.
  const photos = existsSync(PHOTO_MANIFEST)
    ? JSON.parse(readFileSync(PHOTO_MANIFEST, 'utf8')).personas
    : [];
  const photoUrls = new Map(photos.map(p => [p.subjectId, p.portraitUrl]));
  if (photoUrls.size !== photos.length) throw new Error('duplicate portrait identity');
  for (const photo of photos) {
    if (cast.find(person => person.id === photo.subjectId)?.name !== photo.name) throw new Error(`portrait name does not match identity ${photo.subjectId}`);
  }
  for (const [id, url] of photoUrls) {
    if (!ids.has(id) || url !== `/avatars/photos/${id}.jpg`) throw new Error(`invalid photo identity ${id}`);
    if (!existsSync(join(ROOT, 'portal', 'public', url))) throw new Error(`missing portrait ${url}`);
  }

  const files = new Map();
  for (const p of cast) files.set(`${p.id}.svg`, avatarSvg(p));
  const index = {
    generator: 'scripts/avatars/generate-local.mjs',
    note: 'Photographic synthetic portraits from photos/personas.json for all seeded identities; unknown people retain initials. Legacy SVG assets are retained but are not selected by the app.',
    avatars: cast.map(p => ({ id: p.id, kind: p.kind, name: p.name, url: photoUrls.get(p.id) ?? null })),
  };
  files.set('index.json', JSON.stringify(index, null, 2) + '\n');
  files.set('../../../middleware/src/mock/portrait-urls.ts', '// Generated by scripts/avatars/generate-local.mjs from photos/personas.json.\n// Never assign a different person\'s face to a missing identity.\nexport const PORTRAIT_URLS: Readonly<Record<string, string>> = ' + JSON.stringify(Object.fromEntries(photoUrls), null, 2) + ';\n');
  // Vite serves public/ as assets and refuses JS imports from it in dev.
  // Generate a small source module from the same durable portrait manifest.
  files.set('../../src/lib/demoPortraits.json', JSON.stringify({ personas: photos.map(({ subjectId, userId, name, portraitUrl, biography }) =>
    ({ subjectId, userId, name, portraitUrl, biography })) }, null, 2) + '\n');

  if (check) {
    const stale = [...files].filter(([name, body]) => {
      const path = join(OUT_DIR, name);
      return !existsSync(path) || readFileSync(path, 'utf8') !== body;
    }).map(([name]) => name);
    if (stale.length) {
      console.error(`avatars out of date (${stale.length}): ${stale.slice(0, 8).join(', ')}`);
      process.exit(1);
    }
    console.log(`avatars up to date: ${cast.length} faces`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  // Drop faces for ids that left the cast, so the directory is exactly the cast.
  for (const name of readdirSync(OUT_DIR)) {
    if (name.endsWith('.svg') && !files.has(name)) unlinkSync(join(OUT_DIR, name));
  }
  for (const [name, body] of files) writeFileSync(join(OUT_DIR, name), body);
  const people = cast.filter(p => p.kind === 'person').length;
  console.log(`wrote ${cast.length} avatars (${people} people, ${cast.length - people} unlinked users) + index.json → ${OUT_DIR}`);
}

main();
