# shellcheck shell=bash
# Raw-element counting for the component-discipline checks — ONE counter
# (audit 2026-10-07 T7), sourced by validate-component-discipline.sh (its
# per-area budgets) and by every tenant validator's "component discipline
# (<pages dir>)" section, which used to carry its own regex copy.
#
#   dc_queued_files [<prefix>]          files a "Composed locally in `…`" queue row exempts (under prefix)
#   dc_area_files <dir> [<prefix>]      the .tsx files under dir that no queue row exempts
#   dc_count_raw <files...>             raw styled elements (className= or style= on a raw tag), brace-aware:
#                                       an arrow function in an onClick cannot truncate a tag
#   dc_count_re <regex> <files...>      single-line occurrences of a pattern
#
# DC_RAW_RE is the single-line form some callers print offender files with.
#
# A raw element is permitted in exactly one kind of file: a local composite
# standing in for a primitive the library lacks, AND queued for it. Only rows
# that say "Composed locally in `<file>`" mint an exemption — a row that merely
# names where a gap was worked around must not exempt that file. A queued file
# still gets a per-file cap, so "queue it" cannot become "hand-roll it".
#
# Raw styled elements are counted across LINE BREAKS. `grep` matches a line at
# a time, and JSX opening tags routinely span several:
#
#     <input
#       type="range"
#       className="w-full accent-primary"
#     />
#
# A line-based regex cannot see that element at all. Measured when the gate
# was first written: 45 raw elements portal-wide — about 9% — were invisible,
# and "converting" a file could mean nothing more than pushing its className
# onto its own line. `<button` and `style={` stay on grep: both are single
# tokens with no such blind spot. And brace-aware on purpose: the regex this
# replaced, rf'<({EL})(\s[^>]*?)?\sclassName=', cannot cross a `>`, so any
# element carrying an arrow function before its className — `onClick={() => …}`,
# most interactive elements — was invisible. It hid five of them. Until
# 2026-10-08 each tenant validator kept that single-line regex for its own
# pages; they all count through dc_count_raw now.
DC_QUEUE=${DC_QUEUE:-docs/ui-components-queue.md}
DC_RAW_RE='<(div|p|span|h[1-6]|ul|ol|li|section|nav|article|table|tr|td|th|button|a|label|input|textarea|select|form|code|pre)( [^>]*)?className='

dc_queued_files() {
  local prefix=${1:-portal/src/}
  grep -oE "Composed locally in \`${prefix}[A-Za-z0-9_/.-]+\.tsx\`" "$DC_QUEUE" 2>/dev/null \
    | grep -oE "${prefix}[A-Za-z0-9_/.-]+\.tsx" | sort -u
}

dc_area_files() {
  local dir=$1 prefix=${2:-portal/src/} q
  q=$(dc_queued_files "$prefix")
  find "$dir" -name '*.tsx' 2>/dev/null | sort | { if [ -n "$q" ]; then grep -vxF -f <(printf '%s\n' $q); else cat; fi; }
}

dc_count_re() {
  local re="$1"; shift
  local n=0 c f
  for f in "$@"; do
    [ -f "$f" ] || continue
    c=$(grep -oE "$re" "$f" 2>/dev/null | wc -l | tr -d ' ')
    n=$((n + c))
  done
  printf '%s' "$n"
}

dc_count_raw() {
  [ $# -eq 0 ] && { printf '0'; return; }
  python3 - "$@" <<'PY'
import re, sys
EL = r'div|p|span|h[1-6]|ul|ol|li|section|nav|article|table|tr|td|th|button|a|label|input|textarea|select|form|code|pre'
tag_rx = re.compile(rf'<({EL})(?=[\s/>])')

def tag_end(s, i):
    depth = 0; q = None; j = i
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
        elif c == '>' and depth == 0:
            return j
        j += 1
    return -1

total = 0
for path in sys.argv[1:]:
    try:
        s = open(path, encoding='utf-8', errors='ignore').read()
    except OSError:
        continue
    for m in tag_rx.finditer(s):
        end = tag_end(s, m.start())
        # `className=` OR `style=`: a raw <div style={{...}}> with no class is
        # just as hand-rolled as one with a class (this counter's third blind
        # spot, after `[^>]*?` not crossing an arrow function and the style
        # counter ignoring hoisted consts — it was hiding 16).
        if end > 0 and re.search(r'\s(className|style)=', s[m.start():end]):
            total += 1
print(total, end='')
PY
}
