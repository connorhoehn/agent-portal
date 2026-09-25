// parseLiteral's escape-string branch. The seed generator writes a value that
// carries a line break as E'..\n..' (p-observability's two-line summary), so
// the parity harness has to read it back as the string Postgres stores, or the
// summary column would compare a raw token against the mock's real string.
import { parseLiteral } from '../sql-seed.js';

describe('parseLiteral reads escape strings', () => {
  it('decodes \\n and doubled quotes in an E-string', () => {
    expect(parseLiteral("E'Line one.\\nFocus: it''s two.'")).toBe("Line one.\nFocus: it's two.");
  });

  it('decodes an escaped backslash without eating the next character', () => {
    expect(parseLiteral("E'a\\\\nb'")).toBe('a\\nb');
  });

  it('keeps an escape it does not model raw rather than guessing', () => {
    expect(parseLiteral("E'tab\\there'")).toEqual({ raw: "E'tab\\there'" });
  });

  it('leaves a plain literal alone', () => {
    expect(parseLiteral("'plain \\n text'")).toBe('plain \\n text');
  });
});
