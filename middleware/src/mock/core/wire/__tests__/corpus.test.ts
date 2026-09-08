// The second witness must not be talked into anything.

import { corpusOf, serverCorpus } from '../corpus.js';

describe('server corpus', () => {
  it('collects quoted string literals', () => {
    const c = corpusOf([`const kinds = ['local', "synced"];`]);
    expect(c.strings.has('local')).toBe(true);
    expect(c.strings.has('synced')).toBe(true);
  });

  it('does not let a comment vouch for a string', () => {
    // contract.ts and this whole directory describe the bug in prose. If prose
    // counted, the checker would exempt exactly the value it exists to catch.
    const c = corpusOf([`// a fixture keyed 'enterprise' while the server sent 'enterprise_context'\nconst x = 1;`]);
    expect(c.strings.has('enterprise')).toBe(false);
    const block = corpusOf([`/* keyed 'enterprise' */\nconst x = 1;`]);
    expect(block.strings.has('enterprise')).toBe(false);
  });

  it('does not let a template literal vouch either — an enum is never backticked', () => {
    const c = corpusOf(['const s = `enterprise`;']);
    expect(c.strings.has('enterprise')).toBe(false);
  });

  it('collects identifiers so a key name can be looked up', () => {
    const c = corpusOf(['export interface Session { iat: number }']);
    expect(c.words.has('iat')).toBe(true);
    expect(c.words.has('to_verify_higher')).toBe(false);
  });

  it('excludes test files from the real corpus', () => {
    // A fixture that vouches for its own invented string is the failure mode
    // this mechanism exists to close, so __tests__ is not a witness.
    const c = serverCorpus();
    expect(c.strings.has('ghost')).toBe(false);
  });
});
