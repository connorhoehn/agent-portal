// A seeded Design Twitter board mid-interview: the kit's master template (palette and all) plus what a candidate drew in it —
// palette components copied and renamed, two stores drawn as circles, labelled arrows bound to them, notes in the side frames.
import { architectureComponent, base, freeText, masterBoard } from '../../board/templates.js';
import { TWITTER_PROMPT } from '../../../../mock/interviews-design-twitter.js';

type El = Record<string, unknown>;

export function twitterBoard(): { elements: El[]; template: Set<string> } {
  const start = masterBoard(TWITTER_PROMPT, { palette: true }).elements as El[];
  const template = new Set(start.map((e) => String(e['id'])));
  const hld = start.find((e) => e['id'] === 'mt-b-hld')!;
  const X = Number(hld['x']); const Y = Number(hld['y']) + 420;
  let t = 1_000;
  const out: El[] = [...start];
  const comp = (prefix: string, palette: string, label: string, x: number, y: number): string => {
    const els: El[] = architectureComponent(prefix, palette, X + x, Y + y, 'mt-b-hld').map((e): El => ({ ...e, updated: t }));
    const name = els.find((e) => String(e['id']).endsWith('-name'))!;
    name['text'] = label; name['originalText'] = label;
    out.push(...els); t += 10;
    return String(els[0]!['id']);
  };
  const store = (id: string, label: string, x: number, y: number): string => {
    out.push(base(id, 'ellipse', X + x, Y + y, 120, 80, { frameId: 'mt-b-hld', boundElements: [{ type: 'text', id: `${id}-t` }], updated: t }),
      base(`${id}-t`, 'text', X + x + 10, Y + y + 30, 100, 20, { text: label, originalText: label, containerId: id, frameId: 'mt-b-hld', updated: t }));
    t += 10;
    return id;
  };
  const arrow = (id: string, from: string, to: string, label: string): void => {
    out.push(base(id, 'arrow', X, Y, 100, 0, { points: [[0, 0], [100, 0]], startBinding: { elementId: from, focus: 0, gap: 4 }, endBinding: { elementId: to, focus: 0, gap: 4 },
      boundElements: [{ type: 'text', id: `${id}-l` }], frameId: 'mt-b-hld', updated: t }),
    base(`${id}-l`, 'text', X + 40, Y - 10, 60, 20, { text: label, originalText: label, containerId: id, frameId: 'mt-b-hld', updated: t }));
    t += 10;
  };
  const mobile = comp('c1', 'mobile', 'Mobile client', 0, 0);
  const lb = comp('c2', 'lb', 'Load balancer', 160, 0);
  const post = comp('c3', 'app', 'Post service', 320, -120);
  const timeline = comp('c4', 'app', 'Timeline service', 320, 140);
  const posts = store('c5', 'Posts DB (Postgres)', 500, -140);
  const queue = comp('c6', 'queue', 'Fan-out queue', 500, -10);
  const workers = comp('c7', 'workers', 'Fan-out workers', 660, -10);
  const follows = store('c8', 'Follow graph DB', 820, -140);
  const cache = comp('c9', 'cache', 'Timeline cache (Redis)', 660, 140);
  arrow('a1', mobile, lb, 'HTTPS');
  arrow('a2', lb, post, 'POST /tweets');
  arrow('a3', post, posts, 'writes');
  arrow('a4', post, queue, 'publishes tweet id');
  arrow('a5', queue, workers, 'consume');
  arrow('a6', workers, follows, 'reads followers');
  arrow('a7', workers, cache, 'push tweet id to each follower list');
  arrow('a8', lb, timeline, 'GET /timeline');
  out.push(freeText('n1', 0, 0, 'Timeline service: reads the home timeline from the cache, hydrates tweets from Posts DB', { frameId: 'mt-b-purposes' }));
  out.push({ ...freeText('n2', 0, 0, 'posts(id, author_id, body, created_at)\nfollows(follower_id, followee_id)', { frameId: 'mt-b-data' }), updated: t }); t += 10;
  arrow('a9', timeline, cache, 'reads timeline');
  return { elements: out, template };
}
