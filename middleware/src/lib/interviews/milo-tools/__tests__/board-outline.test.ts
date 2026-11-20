// The board as text (board-outline.ts) on a seeded Design Twitter board: the candidate's components with their kinds, the
// arrows FROM -> TO by their bindings with their labels, notes verbatim per frame, the newest change, nothing of the template.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { boardOutline, kindOf } from '../board-outline.js';
import { twitterBoard } from './twitter-board.js';

describe('the board outline', () => {
  const { elements, template } = twitterBoard();
  const out = boardOutline(elements, { template })!;

  it('components by frame, with a kind from their words or shape', () => {
    expect(out).toContain('<frame name="High-level design">');
    expect(out).toContain('<component kind="service">Timeline service</component>');
    expect(out).toContain('<component kind="cache">Timeline cache (Redis)</component>');
    expect(out).toContain('<component kind="store">Posts DB (Postgres)</component>');
    expect(out).toContain('<component kind="queue">Fan-out queue</component>');
    expect(out).toContain('<component kind="client">Mobile client</component>');
  });

  it('arrows FROM -> TO through their bindings (a grouped palette icon resolves to its name), with the label', () => {
    expect(out).toContain('<arrow from="Timeline service" to="Timeline cache (Redis)" label="reads timeline"/>');
    expect(out).toContain('<arrow from="Fan-out workers" to="Follow graph DB" label="reads followers"/>');
    expect(out).toContain('<arrow from="Load balancer" to="Post service" label="POST /tweets"/>');
    // The load balancer icon's own arrows are part of the icon.
    expect(out).not.toMatch(/<arrow from="([^"]+)" to="\1"/);
  });

  it('notes verbatim in their frames; the newest change first; nothing of the template (prompt, hints, palette)', () => {
    expect(out).toMatch(/<frame name="Data model">\n\s+<text>posts\(id, author_id, body, created_at\) follows\(follower_id, followee_id\)<\/text>/);
    expect(out).toMatch(/<recent newest-first="true">arrow Timeline service -&gt; Timeline cache \(Redis\) \(reads timeline\)/);
    expect(out).not.toMatch(/Web client|CDN|Click selects|Functional only|Design Twitter/);
    expect(out.length).toBeLessThan(4_000);
  });

  it('capped at a line, keeping the newest changes; nothing drawn: null', () => {
    const small = boardOutline(elements, { template, maxChars: 400 })!;
    expect(small.length).toBeLessThanOrEqual(400);
    expect(small).toMatch(/more lines left out/);
    expect(small).toMatch(/<recent/);
    expect(boardOutline(elements.filter((e) => template.has(String(e['id']))), { template })).toBeNull();
  });

  it('kinds', () => {
    expect(kindOf('Kafka', ['rectangle'])).toBe('queue');
    expect(kindOf('', ['ellipse'])).toBe('store');
    expect(kindOf('Feed', ['rectangle'])).toBe('service');
  });
});
