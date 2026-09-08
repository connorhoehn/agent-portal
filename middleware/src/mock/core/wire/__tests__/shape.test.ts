// What gets remembered from a response, and what deliberately does not.

import { describe as describeBody, sortShape, keyNamesOf, looksLikeDictionary, fieldName, type Json } from '../shape.js';

describe('shape', () => {
  it('collapses array indices, so 200 rows contribute one path per field', () => {
    const body: Json = { sections: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] };
    expect(sortShape(describeBody(body).shape)).toEqual({
      $: 'object',
      sections: 'array',
      'sections[]': 'object',
      'sections[].key': 'string',
    });
  });

  it('merges a field only some rows carry, rather than taking row one as law', () => {
    const body: Json = { rows: [{ a: 1 }, { a: 2, b: 'x' }] };
    const shape = describeBody(body).shape;
    expect(shape['rows[].b']).toBe('string');
  });

  it('records a nullable column as a union, not as whichever row came first', () => {
    const body: Json = { rows: [{ a: null }, { a: 'x' }] };
    expect(describeBody(body).shape['rows[].a']).toBe('null|string');
  });

  it('remembers wire-shaped values by PATH, never by bare field name', () => {
    const body: Json = { sections: [{ key: 'enterprise_context' }, { key: 'rules' }] };
    const { values } = describeBody(body);
    expect([...(values.get('sections[].key') ?? [])].sort()).toEqual(['enterprise_context', 'rules']);
    expect(values.has('key')).toBe(false);
  });

  it('ignores values of fields that are open sets', () => {
    // `title` is free text; asserting a fixture may only use titles the seed
    // happens to contain is not this checker's job.
    const { values } = describeBody({ rows: [{ title: 'Anything at all' }] });
    expect(values.size).toBe(0);
  });

  it('reads a map-shaped object as a vocabulary, not as thirty key paths', () => {
    // GET /api/session/capabilities sends capability names this way.
    const actions: Json = {
      Search: true, ViewOrgChart: true, ViewLeaderboard: false, ManageBots: false,
      ManageKB: true, ManageIngest: false, EditPolicy: false, Masquerade: true,
    };
    expect(looksLikeDictionary(actions)).toBe(true);
    const { shape, values } = describeBody({ actions });
    expect(shape['actions']).toBe('object(dictionary)');
    expect(shape['actions.Search']).toBeUndefined();
    expect(values.get('actions')?.has('Masquerade')).toBe(true);
  });

  it('does not mistake a small record for a dictionary', () => {
    expect(looksLikeDictionary({ a: 1, b: 2, c: 3 })).toBe(false);
    // Mixed value types are a real object, whatever its size.
    expect(looksLikeDictionary({ a: 1, b: 'x', c: true, d: 1, e: 1, f: 1, g: 1, h: 1 })).toBe(false);
  });

  it('names the key at a path', () => {
    expect(fieldName('a.b[].section_key')).toBe('section_key');
    expect(fieldName('sections[]')).toBe('sections');
  });

  it('lists every key name a shape mentions', () => {
    const { shape } = describeBody({ sections: [{ nodes: [{ classification: 'internal' }] }] });
    expect([...keyNamesOf(shape)].sort()).toEqual(['classification', 'nodes', 'sections']);
  });

  it('merges several responses into one shape when asked to', () => {
    const merged = describeBody({ a: 1 });
    describeBody({ b: 'x' }, merged);
    expect(sortShape(merged.shape)).toEqual({ $: 'object', a: 'number', b: 'string' });
  });
});
