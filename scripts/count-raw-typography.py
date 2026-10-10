#!/usr/bin/env python3
"""Count raw type utilities on bare <span>/<div>/<p> text nodes in portal/src.

A tag is walked brace-aware (the first `>` at brace depth 0 closes it, so an
`onClick={(e) => ...}` arrow cannot truncate it) and counts once per utility
matched in its className: text-(xs|sm|base|lg|xl), font-(medium|semibold|bold).
Tests, stories and node_modules are skipped. Typography belongs in the library's
`T`/`Text` (size/weight/tone props), never in a class on a bare element.
"""
import re, sys, pathlib
TAG = re.compile(r'<(span|div|p)\b')
UTIL = re.compile(r'(?<![\w-])(?:text-(?:xs|sm|base|lg|xl)|font-(?:medium|semibold|bold))(?![\w-])')
def tag_end(s, i):
    depth = 0; q = None
    while i < len(s):
        c = s[i]
        if q:
            if c == q: q = None
        elif c in '"\'`' and depth == 0 or (c in '"\'`' and depth > 0): q = c
        elif c == '{': depth += 1
        elif c == '}': depth -= 1
        elif c == '>' and depth == 0 and s[i-1] != '=': return i
        i += 1
    return len(s)
root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'portal/src')
total = 0
for f in sorted(root.rglob('*.tsx')):
    p = str(f)
    if '/node_modules/' in p or '.test.' in p or '.stories.' in p or '/__tests__/' in p: continue
    s = f.read_text()
    for m in TAG.finditer(s):
        tag = s[m.start():tag_end(s, m.end())]
        cn = re.search(r'className=(?:"([^"]*)"|\{(.*))', tag, re.S)
        if cn: total += len(UTIL.findall(cn.group(1) or cn.group(2)))
        if '--files' in sys.argv and cn and UTIL.search(cn.group(1) or cn.group(2)): print(p)
print(total)
