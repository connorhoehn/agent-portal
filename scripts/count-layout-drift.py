#!/usr/bin/env python3
"""Count page-local compositions that drift from the library's type scale.

The component-discipline gate counts RAW elements, and the portal is at zero —
yet pages still read inconsistent, because the drift moved one level up: a
library `T` with `className="text-[11px]"`, a card-variant `StatStrip` with
17px values on a list page, a table cell that stacks a caption and a bar under
its value, a `✕` glyph standing in for an icon. Every one of those is built
FROM library primitives, so the raw counter cannot see it.

Usage:
  count-layout-drift.py [root]            # "<class> <count>" per class
  count-layout-drift.py [root] --list     # also every offending file:line

Classes (each a ratchet in validate-component-discipline.sh):
  bar          a hand-drawn bar/meter: a tag whose className carries h-1/h-1.5/
               h-2 (or h-[≤8px]) + rounded-full + bg-, and no matching w- (that
               is a dot). Use ProgressBar / MeterRow / StatStrip progress.
  bigtext      text-xl / text-2xl / text-3xl / text-[17px+] in a className. The
               page title (PageHeader / PageSection) is the only 20px text and
               it comes from the library.
  cardstat     a card-variant StatStrip (no `variant="line"`/`"inline"`) or a
               StatCard, outside the dashboards allow-listed in
               scripts/card-stat-allowed.txt. Use StatStrip variant="line"
               size="sm".
  stackedcell  a TableTd whose body has two or more top-level block children
               (T, Stack, ProgressBar, div, p, Card, Inline) or a Stack, or a
               DataTable column `render` whose root is a Stack or a fragment of
               two blocks: a second line inside a row. Put the meter inline beside the value
               and the caption in a title/Chip.
  glyphbutton  a bare ×/✕/✖ glyph as an element's text — a close/remove
               button drawn with a character. Use IconButton icon={<CloseIcon/>}
               (or TrashIcon) with an aria-label.
  pxtype       an arbitrary text-[Npx] size in a className. Size is the
               library's: T size="xs|sm|base", or the composite's own size prop.
  cellbutton   a text `<Button` inside a table cell — a TableTd body, a
               DataTable column `render`, or `rowActions`. A cell holds one
               thing; its only control is an IconButton (docs/layout-cascade.md
               "Tables"). Secondary facts go to a meta column, a Chip with a
               title, or the row's detail pane.
  lonesearch   a searchable DataTable alongside a page-local Toolbar or
               CollectionToolbar: two competing control rows. Standalone
               searchable DataTable uses CollectionToolbar since 2.440.2 and
               inherits its geometry; it is no longer inherently a violation.
  tablesize    a `<DataTable` or `<Table` drawn off the 44px one-line step: an
               explicit `size` other than sm. Since ui-components 2.440 the
               shell's `<DensityProvider density="compact">` (portal/src/main.tsx)
               puts every table on that step with no prop.
  densitysize  an explicit `size="sm"` on a composite the compact density
               already draws at sm (StatStrip, PageSection, DetailSection,
               ActionRowList, Table, DataTable, EmptyState, ChatSidePanelFrame,
               not PageSection — its size is the heading level,
               SegmentedControl, WorkflowStepper): the per-call restatement
               of the house density (audit 2026-10-07 H15/L1). Budget: zero.
Tests, stories and node_modules are skipped.
"""
import pathlib, re, sys

args = [a for a in sys.argv[1:] if not a.startswith('--')]
LIST = '--list' in sys.argv
root = pathlib.Path(args[0] if args else 'portal/src')
here = pathlib.Path(__file__).resolve().parent
allowed_path = here / 'card-stat-allowed.txt'
ALLOWED = set()
if allowed_path.exists():
    for line in allowed_path.read_text().splitlines():
        line = line.split('#', 1)[0].strip()
        if line:
            ALLOWED.add(line)

TAG = re.compile(r'<([A-Za-z][\w.]*)(?=[\s/><])')


def tag_end(s, i):
    """Index of the `>` closing the tag that opens at i (brace/quote aware:
    an `onClick={(e) => …}` arrow cannot truncate it)."""
    depth = 0; q = None; j = i
    m = TAG.match(s, i)
    if m and m.end() < len(s) and s[m.end()] == '<':
        # a generic component (`<DataTable<Row>`): skip its type argument
        g = 0
        j = m.end()
        while j < len(s):
            if s[j] == '<':
                g += 1
            elif s[j] == '>':
                g -= 1
                if g == 0:
                    break
            j += 1
        j += 1
    while j < len(s):
        c = s[j]
        if q:
            if c == q and s[j - 1] != '\\':
                q = None
        elif c in '"\'`':
            q = c
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        elif c == '>' and depth == 0 and s[j - 1] != '=':
            return j
        j += 1
    return len(s) - 1


def top_attrs(tag):
    """The tag with every `{…}` expression blanked: only its own literal
    attributes, never a prop nested in a render function inside it."""
    out = []; depth = 0
    for c in tag:
        if c == '{':
            depth += 1
            if depth == 1:
                out.append('{')
            continue
        if c == '}':
            depth -= 1
            if depth == 0:
                out.append('}')
            continue
        if depth == 0:
            out.append(c)
    return ''.join(out)


def class_of(tag):
    """The tag's OWN className — one at brace depth 0, never a className
    inside a render prop nested in the tag."""
    for m in re.finditer(r'className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})', tag, re.S):
        pre = tag[:m.start()]
        if pre.count('{') - pre.count('}') == 0:
            return m.group(1) or m.group(2) or m.group(3) or ''
    return ''


BAR_H = re.compile(r'(?<![\w-])h-(?:1|1\.5|2|\[[1-8]px\])(?![\w.-])')
DOT_W = re.compile(r'(?<![\w-])w-(?:1|1\.5|2|2\.5|\[[1-8]px\])(?![\w.-])')
BIG = re.compile(r'(?<![\w-])text-(?:xl|2xl|3xl|4xl|\[(?:1[7-9]|[2-9]\d)(?:\.\d+)?px\])(?![\w-])')
PX = re.compile(r'(?<![\w-])text-\[\d+(?:\.\d+)?px\]')
GLYPH = re.compile(r'>\s*(?:\{\s*[\'"])?[×✕✖](?:[\'"]\s*\})?\s*</', re.S)
BLOCK = {'T', 'Text', 'Stack', 'ProgressBar', 'div', 'p', 'Card', 'Inline', 'MetaLine'}


def top_level_children(body):
    """Names of the JSX elements at depth 0 inside a cell body."""
    out = []; depth = 0; i = 0
    while i < len(body):
        if body.startswith('</', i):
            depth -= 1
            i = body.find('>', i) + 1 or len(body)
            continue
        m = TAG.match(body, i)
        if m:
            end = tag_end(body, i)
            if depth == 0:
                out.append(m.group(1))
            if body[end - 1] != '/':
                depth += 1
            i = end + 1
            continue
        i += 1
    return out


RENDER = re.compile(r'render\s*:\s*\([^)]*\)\s*=>\s*\(?\s*<(>|[A-Za-z][\w.]*)')


def line_of(s, i):
    return s.count('\n', 0, i) + 1


def fn_body(s, i):
    """The body of the arrow function whose `=>` follows index i — a
    parenthesised expression or a braced block, matched by bracket depth."""
    a = s.find('=>', i)
    if a < 0 or a - i > 200:
        return ''
    j = a + 2
    while j < len(s) and s[j] in ' \t\n':
        j += 1
    if j >= len(s):
        return ''
    if s[j] not in '({':
        # a bare expression: up to the end of the line
        e = s.find('\n', j)
        return s[j:e if e > 0 else len(s)]
    depth = 0
    for k in range(j, len(s)):
        c = s[k]
        if c in '({[':
            depth += 1
        elif c in ')}]':
            depth -= 1
            if depth == 0:
                return s[j:k + 1]
    return s[j:]


CELLFN = re.compile(r'(?:\brender\s*:|\browActions\s*=\s*\{)\s*\(')
BUTTON = re.compile(r'<Button(?=[\s/>])')


# PageSection is deliberately NOT here: its size chooses the heading LEVEL (lg = the page's
# h1, md/sm = an h2 subsection), so an explicit `size="sm"` is semantics, not a density
# restatement. Density only tightens its spacing (ui-components 2.441.5).
DENSITY_COMPOSITES = {'StatStrip', 'DetailSection', 'ActionRowList', 'Table', 'DataTable', 'EmptyState', 'ChatSidePanelFrame', 'SegmentedControl', 'WorkflowStepper'}

hits = {k: [] for k in ('bar', 'bigtext', 'cardstat', 'stackedcell', 'glyphbutton', 'pxtype', 'cellbutton', 'lonesearch', 'tablesize', 'densitysize')}
for f in sorted(root.rglob('*.tsx')):
    p = str(f)
    if '/node_modules/' in p or '.test.' in p or '.stories.' in p or '/__tests__/' in p:
        continue
    s = f.read_text(encoding='utf-8', errors='ignore')
    rel = p
    for m in TAG.finditer(s):
        name = m.group(1)
        end = tag_end(s, m.start())
        tag = s[m.start():end + 1]
        cls = class_of(tag)
        ln = line_of(s, m.start())
        if cls:
            if BAR_H.search(cls) and 'rounded-full' in cls and re.search(r'(?<![\w-])bg-', cls) and not DOT_W.search(cls):
                hits['bar'].append(f'{rel}:{ln}')
            for _ in BIG.findall(cls):
                hits['bigtext'].append(f'{rel}:{ln}')
            for _ in PX.findall(cls):
                hits['pxtype'].append(f'{rel}:{ln}')
        attrs = top_attrs(tag)
        if name == 'DataTable' and re.search(r'(?<![\w-])searchable(?![\w-])(?!=\{\})', attrs) and re.search(r'<(?:Toolbar|CollectionToolbar)(?=[\s/>])', s):
            hits['lonesearch'].append(f'{rel}:{ln}')
        if name in ('DataTable', 'Table') and re.search(r'(?<![\w-])size=', attrs) and not re.search(r'size=["\']sm["\']', attrs):
            hits['tablesize'].append(f'{rel}:{ln}')
        if name in DENSITY_COMPOSITES and re.search(r'(?<![\w-])size=["\']sm["\']', attrs):
            hits['densitysize'].append(f'{rel}:{ln}')
        if name in ('StatStrip', 'StatCard'):
            card = name == 'StatCard' or not re.search(r'variant=["\'{]+(?:line|inline)', tag)
            if card and not any(rel.endswith(a) for a in ALLOWED):
                hits['cardstat'].append(f'{rel}:{ln}')
        # A colSpan cell is an expansion row (failure reasons, a payload), not
        # a second line inside a data row.
        if name == 'TableTd' and not tag.endswith('/>') and 'colSpan' not in tag:
            close = s.find('</TableTd>', end)
            if close > 0:
                if BUTTON.search(s[end + 1:close]):
                    hits['cellbutton'].append(f'{rel}:{ln}')
                kids = top_level_children(s[end + 1:close])
                blocks = [k for k in kids if k in BLOCK]
                if 'Stack' in kids or len(blocks) >= 2:
                    hits['stackedcell'].append(f'{rel}:{ln}')
    # DataTable cells: a column `render` whose root is a Stack, or a fragment
    # with two block children, is a second line inside the row.
    for r in RENDER.finditer(s):
        root = r.group(1)
        lt = s.rfind('<', 0, r.end())
        if root == 'Stack':
            hits['stackedcell'].append(f'{rel}:{line_of(s, lt)}')
        elif root == '>':
            close = s.find('</>', lt)
            if close > 0:
                kids = top_level_children(s[lt + 2:close])
                if 'Stack' in kids or len([k for k in kids if k in BLOCK]) >= 2:
                    hits['stackedcell'].append(f'{rel}:{line_of(s, lt)}')
    # A text Button in a DataTable cell or its row actions; and a block-bodied
    # render whose returned root is a Stack (a second line).
    for c in CELLFN.finditer(s):
        body = fn_body(s, c.start())
        if BUTTON.search(body):
            hits['cellbutton'].append(f'{rel}:{line_of(s, c.start())}')
        if body.startswith('{') and re.search(r'return\s*\(?\s*<Stack(?=[\s/>])', body):
            hits['stackedcell'].append(f'{rel}:{line_of(s, c.start())}')
    for g in GLYPH.finditer(s):
        hits['glyphbutton'].append(f'{rel}:{line_of(s, g.start())}')

for k, v in hits.items():
    print(f'{k} {len(v)}')
    if LIST:
        for h in v:
            print(f'    {h}')
