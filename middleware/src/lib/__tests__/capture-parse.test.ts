// Change-capture parsing — the paths every path-based policy gate reads.
//
// These pin the two bugs that let sensitive changes slip past governance: an
// untracked file collapsed to its directory (so `**/*.secret` never matched),
// and a git failure being read as a clean tree.

import { isGitFailure, parsePorcelainFiles } from '../capture-parse.js';

describe('isGitFailure', () => {
  it('flags a dubious-ownership / fatal read', () => {
    expect(isGitFailure('fatal: detected dubious ownership in repository')).toBe(true);
    expect(isGitFailure(' M src/a.ts\nerror: something')).toBe(true);
  });
  it('does not flag a clean or normal status', () => {
    expect(isGitFailure(' A infra/x.ts\n?? notes.txt')).toBe(false);
    expect(isGitFailure('')).toBe(false);
    // "fatal:" only mid-line (e.g. inside a filename) must not trip it.
    expect(isGitFailure(' A docs/why-not-fatal.md')).toBe(false);
  });
});

describe('parsePorcelainFiles', () => {
  it('extracts the path from each status code', () => {
    expect(parsePorcelainFiles(' A infra/PROOF.md')).toEqual(['infra/PROOF.md']);
    expect(parsePorcelainFiles('AM notes.txt')).toEqual(['notes.txt']);
    expect(parsePorcelainFiles(' M src/app.ts')).toEqual(['src/app.ts']);
  });

  it('keeps untracked files as full paths (the -uall fix), not directories', () => {
    // The whole point of -uall: a sensitive file in a new dir is visible by its
    // real path, so a protected_paths gate can match **/*.secret.
    expect(parsePorcelainFiles('?? config/app.secret')).toEqual(['config/app.secret']);
    expect(parsePorcelainFiles('?? src/api/auth/login.ts')).toEqual(['src/api/auth/login.ts']);
  });

  it('takes the new path for a rename/copy', () => {
    expect(parsePorcelainFiles('R  old/name.ts -> new/name.ts')).toEqual(['new/name.ts']);
    expect(parsePorcelainFiles('C  a.ts -> b.ts')).toEqual(['b.ts']);
  });

  it('handles many lines and ignores blanks', () => {
    expect(parsePorcelainFiles(' A infra/a.tf\n?? config/b.secret\n\n M src/c.ts\n'))
      .toEqual(['infra/a.tf', 'config/b.secret', 'src/c.ts']);
  });

  it('returns [] for a clean tree', () => {
    expect(parsePorcelainFiles('')).toEqual([]);
    expect(parsePorcelainFiles('\n\n')).toEqual([]);
  });
});
