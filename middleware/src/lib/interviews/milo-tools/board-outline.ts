// The board as text Milo can read: a compact outline of the saved Excalidraw scene, frame by frame — the candidate's components
// (label and kind), the arrows between them (label, FROM -> TO, resolved through the arrow's bindings, else its nearest
// component), their free text verbatim, and what changed last. Pure; size-capped. The kit's own template (the prompt, hints, the
// palette) is left out by id, so what is described is what the candidate drew. Read by the probe writer (probe.ts).
type El = Record<string, unknown>;

export const OUTLINE_MAX_CHARS = 4_000;
const TEXT_MAX = 160;
const RECENT = 3;
/** An unbound arrow end this close to a component's box (scene units) is attached to it. */
const NEAR = 60;

const clean = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SHAPES = new Set(['rectangle', 'ellipse', 'diamond']);

/** A component's kind: by its words first (the candidate named it), else by its shape (stores as circles, services as boxes). */
export function kindOf(label: string, shapes: readonly string[]): string {
  const l = label.toLowerCase();
  if (/\b(cache|redis|memcached?)\b/.test(l)) return 'cache';
  if (/\b(queue|kafka|sqs|kinesis|stream|pub ?sub|topic)\b/.test(l)) return 'queue';
  if (/\b(db|database|store|storage|postgres(ql)?|mysql|dynamo(db)?|cassandra|s3|blob|table|index)\b/.test(l)) return 'store';
  if (/\b(client|browser|mobile|web app|user)\b/.test(l)) return 'client';
  if (/\b(load balancer|lb|gateway)\b/.test(l)) return 'gateway';
  if (/\bcdn\b/.test(l)) return 'cdn';
  if (/\bworkers?\b/.test(l)) return 'worker';
  if (shapes.length && shapes.every((s) => s === 'ellipse')) return 'store';
  if (shapes.includes('diamond') && !shapes.includes('rectangle')) return 'decision';
  return 'service';
}

interface Node { key: string; label: string; kind: string; frame: string | null; box: [number, number, number, number]; updated: number }

/**
 * The outline. `template`: ids of the kit's starting board (left out); frames are kept whatever made them, as structure.
 * Null when the candidate has drawn and written nothing.
 */
export function boardOutline(elements: ReadonlyArray<El>, opts: { template?: ReadonlySet<string>; maxChars?: number } = {}): string | null {
  const template = opts.template ?? new Set<string>();
  const live = elements.filter((e) => e && typeof e === 'object' && e['isDeleted'] !== true);
  const byId = new Map(live.map((e) => [String(e['id']), e]));
  const frameName = new Map(live.filter((e) => e['type'] === 'frame').map((f) => [String(f['id']), clean(f['name']) || 'Untitled frame']));
  const mine = live.filter((e) => e['type'] !== 'frame' && !template.has(String(e['id'])));
  if (!mine.length) return null;
  const frameOf = (e: El): string | null => (typeof e['frameId'] === 'string' ? frameName.get(e['frameId']) ?? null : null);
  const groupOf = (e: El): string | null => (Array.isArray(e['groupIds']) && typeof e['groupIds'][0] === 'string' ? `g:${e['groupIds'][0] as string}` : null);

  // Components: a group of elements with shapes (a palette icon copied), or a lone shape. Its label: text bound to one of its
  // shapes, else the group's own text.
  const members = new Map<string, El[]>();
  for (const e of mine) {
    if (e['type'] === 'arrow' || (e['type'] === 'text' && typeof e['containerId'] === 'string' && byId.get(e['containerId'] as string)?.['type'] === 'arrow')) continue;
    const key = groupOf(e) ?? (SHAPES.has(String(e['type'])) ? `e:${String(e['id'])}` : null);
    if (!key) continue;
    members.set(key, [...(members.get(key) ?? []), e]);
  }
  const nodeOfEl = new Map<string, string>();
  const nodes = new Map<string, Node>();
  const bound = new Set<string>();
  for (const [key, els] of members) {
    const shapes = els.filter((e) => SHAPES.has(String(e['type'])));
    if (!shapes.length) continue;
    const ids = new Set(els.map((e) => String(e['id'])));
    const texts = mine.filter((t) => t['type'] === 'text' && ((typeof t['containerId'] === 'string' && ids.has(t['containerId'] as string)) || ids.has(String(t['id']))));
    for (const t of texts) bound.add(String(t['id']));
    const label = texts.map((t) => clean(t['text'])).filter(Boolean).join(' ').slice(0, TEXT_MAX);
    const xs = els.map((e) => num(e['x'])); const ys = els.map((e) => num(e['y']));
    const x2 = els.map((e) => num(e['x']) + num(e['width'])); const y2 = els.map((e) => num(e['y']) + num(e['height']));
    nodes.set(key, {
      key, label: label || `unlabelled ${shapes[0]!['type'] as string}`, kind: kindOf(label, shapes.map((s) => String(s['type']))),
      frame: frameOf(shapes[0]!), box: [Math.min(...xs), Math.min(...ys), Math.max(...x2), Math.max(...y2)],
      updated: Math.max(...[...els, ...texts].map((e) => num(e['updated']))),
    });
    for (const e of els) nodeOfEl.set(String(e['id']), key);
  }
  const nearest = (x: number, y: number): Node | null => {
    let best: Node | null = null; let d = NEAR;
    for (const n of nodes.values()) {
      const [a, b, c, e] = n.box;
      const dist = Math.hypot(Math.max(a - x, 0, x - c), Math.max(b - y, 0, y - e));
      if (dist <= d) { d = dist; best = n; }
    }
    return best;
  };
  const end = (arrow: El, which: 'start' | 'end'): Node | null => {
    const b = arrow[`${which}Binding`] as { elementId?: unknown } | null | undefined;
    const id = typeof b?.elementId === 'string' ? b.elementId : null;
    if (id) {
      const key = nodeOfEl.get(id);
      if (key) return nodes.get(key) ?? null;
    }
    const pts = Array.isArray(arrow['points']) ? (arrow['points'] as Array<[number, number]>) : [[0, 0]];
    const p = which === 'start' ? pts[0] : pts[pts.length - 1];
    return nearest(num(arrow['x']) + num(p?.[0]), num(arrow['y']) + num(p?.[1]));
  };
  // An arrow inside a component's group is part of its icon (the load balancer's), not a connection.
  const arrows = mine.filter((e) => e['type'] === 'arrow' && !nodes.has(groupOf(e) ?? '')).map((a) => {
    const label = mine.filter((t) => t['type'] === 'text' && t['containerId'] === a['id']).map((t) => clean(t['text'])).join(' ').slice(0, TEXT_MAX);
    const from = end(a, 'start'); const to = end(a, 'end');
    return { from: from?.label ?? '?', to: to?.label ?? '?', label, frame: frameOf(a) ?? from?.frame ?? null, updated: num(a['updated']) };
  });
  const arrowIds = new Set(mine.filter((e) => e['type'] === 'arrow').map((e) => String(e['id'])));
  const notes = mine.filter((t) => t['type'] === 'text' && !bound.has(String(t['id'])) && !(typeof t['containerId'] === 'string' && arrowIds.has(t['containerId'] as string)))
    .map((t) => ({ text: clean(t['text']).slice(0, TEXT_MAX), frame: frameOf(t), updated: num(t['updated']) })).filter((n) => n.text);

  // Frame by frame, in the order the scene names them; then whatever sits in no frame.
  const lines: string[] = ['<board>'];
  const frames = [...new Set([...frameName.values()]), null];
  for (const f of frames) {
    const ns = [...nodes.values()].filter((n) => n.frame === f);
    const as = arrows.filter((a) => a.frame === f);
    const ts = notes.filter((n) => n.frame === f);
    if (!ns.length && !as.length && !ts.length) continue;
    lines.push(f === null ? '  <outside-frames>' : `  <frame name="${esc(f)}">`);
    for (const n of ns) lines.push(`    <component kind="${n.kind}">${esc(n.label)}</component>`);
    for (const a of as) lines.push(`    <arrow from="${esc(a.from)}" to="${esc(a.to)}"${a.label ? ` label="${esc(a.label)}"` : ''}/>`);
    for (const t of ts) lines.push(`    <text>${esc(t.text)}</text>`);
    lines.push(f === null ? '  </outside-frames>' : '  </frame>');
  }
  const recent = [
    ...[...nodes.values()].map((n) => ({ at: n.updated, what: `component ${n.label}` })),
    ...arrows.map((a) => ({ at: a.updated, what: `arrow ${a.from} -> ${a.to}${a.label ? ` (${a.label})` : ''}` })),
    ...notes.map((n) => ({ at: n.updated, what: `text "${n.text.slice(0, 60)}"` })),
  ].sort((a, b) => b.at - a.at).slice(0, RECENT);
  if (recent.length) lines.push(`  <recent newest-first="true">${recent.map((r) => esc(r.what)).join(' | ')}</recent>`);
  lines.push('</board>');
  const max = opts.maxChars ?? OUTLINE_MAX_CHARS;
  let out = lines.join('\n');
  // Over the cap: the outline is cut at a line, keeping the newest changes (the last line) and saying how much was left out.
  if (out.length > max) {
    const tail = lines.slice(-2);
    const kept: string[] = [];
    let size = tail.join('\n').length + 40;
    for (const l of lines.slice(0, -2)) { if (size + l.length + 1 > max) break; kept.push(l); size += l.length + 1; }
    out = [...kept, `  <!-- ${lines.length - 2 - kept.length} more lines left out -->`, ...tail].join('\n');
  }
  return out;
}
