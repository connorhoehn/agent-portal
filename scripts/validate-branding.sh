#!/usr/bin/env bash
# Definition of done for docs/branding-goal.md. Exit 0 only when every check passes.
set -u
cd "$(dirname "$0")/.."
FAILS=(); ok(){ printf '  ✓ %s\n' "$1"; }; fail(){ printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }; section(){ printf '\n== %s ==\n' "$1"; }
CSS=portal/src/app.css
QUICK=0; for a in "$@"; do case "$a" in --quick) QUICK=1;; esac; done
SEAL=0; for a in "$@"; do case "$a" in --seal) SEAL=1;; esac; done

section "tokens (portal/src/app.css @theme)"
theme_block=$(awk '/^@theme *\{/{f=1;next} f&&/^\}/{f=0} f' "$CSS")
val(){ echo "$theme_block" | grep -oE "^ *$1: *[^;]+;" | head -1 | sed -E "s/^ *$1: *//; s/;$//; s/ +$//"; }
layers=(--color-bg --color-surface-panel --color-surface --color-surface-inset)
missing=""; for t in "${layers[@]}" --color-brand --color-brand-ink --color-brand-soft --background-image-brand-gradient; do [ -n "$(val "$t")" ] || missing="$missing $t"; done
[ -z "$missing" ] && ok "surface layers + brand family declared in @theme" || fail "missing @theme tokens:$missing"
vals=""; for t in "${layers[@]}"; do vals="$vals\n$(val "$t" | tr 'A-F' 'a-f')"; done
distinct=$(printf "$vals" | grep -v '^$' | sort -u | wc -l | tr -d ' ')
[ "$distinct" = 4 ] && ok "the four surface layers are four distinct values (light)" || fail "surface layers are not distinct in light: $(printf "$vals" | tr '\n' ' ')"
[ "$(val --color-primary)" = "var(--color-brand)" ] && ok "--color-primary defaults to --color-brand" || fail "--color-primary must default to var(--color-brand) (is '$(val --color-primary)')"

section "dark theme"
dark_block=$(awk '/^(html)?\[data-theme="dark"\] *\{/{f=1;next} f&&/^\}/{f=0} f' "$CSS")
if [ -z "$dark_block" ]; then fail "no [data-theme=\"dark\"] block in app.css"; else
  light_tokens=$(echo "$theme_block" | grep -oE '^ *--color-[a-z-]+:' | tr -d ' :' | sort -u)
  dark_tokens=$(echo "$dark_block" | grep -oE '^ *--color-[a-z-]+:' | tr -d ' :' | sort -u)
  light_only=$(comm -23 <(echo "$light_tokens") <(echo "$dark_tokens") | tr '\n' ' ')
  [ -z "$light_only" ] && ok "every @theme colour token has a dark value" || fail "colour tokens with no dark value: $light_only"
  dval(){ echo "$dark_block" | grep -oE "^ *$1: *[^;]+;" | head -1 | sed -E "s/^ *$1: *//; s/;$//"; }
  dvals=""; for t in "${layers[@]}"; do dvals="$dvals\n$(dval "$t" | tr 'A-F' 'a-f')"; done
  ddistinct=$(printf "$dvals" | grep -v '^$' | sort -u | wc -l | tr -d ' ')
  [ "$ddistinct" = 4 ] && ok "the four surface layers are four distinct values (dark)" || fail "dark surface layers are not distinct: $(printf "$dvals" | tr '\n' ' ')"
fi

section "tenants"
for t in orgiq assessment; do
  blk=$(awk -v s="[data-tenant=\"$t\"]" 'index($0,s)==1{f=1;next} f&&/^\}/{f=0} f' "$CSS")
  b=$(echo "$blk" | grep -oE '^ *--color-brand: *[^;]+' | head -1 | sed -E 's/.*: *//')
  [ -n "$b" ] && ok "[data-tenant=$t] sets --color-brand ($b)" || fail "[data-tenant=\"$t\"] block missing --color-brand"
  # var() in a custom property resolves at the declaring element, so the alias
  # on :root cannot follow the tenant — each block must restate --color-primary.
  pr=$(echo "$blk" | grep -oE '^ *--color-primary: *[^;]+' | head -1 | sed -E 's/.*: *//')
  [ -n "$pr" ] && [ "$pr" = "$b" ] && ok "[data-tenant=$t] restates --color-primary = its brand" || fail "[data-tenant=\"$t\"] must set --color-primary to its own brand ($b), not inherit the :root alias"
  dblk=$(awk -v s="html[data-theme=\"dark\"] [data-tenant=\"$t\"]" 'index($0,s)==1{f=1;next} f&&/^\}/{f=0} f' "$CSS")
  db=$(echo "$dblk" | grep -oE '^ *--color-brand: *[^;]+' | head -1 | sed -E 's/.*: *//'); dpr=$(echo "$dblk" | grep -oE '^ *--color-primary: *[^;]+' | head -1 | sed -E 's/.*: *//')
  [ -n "$db" ] && [ "$dpr" = "$db" ] && ok "[data-tenant=$t] dark restates --color-primary = its brand" || fail "html[data-theme=\"dark\"] [data-tenant=\"$t\"] must set --color-brand and --color-primary"
  eval "brand_$t='$b'"
done
[ -n "${brand_orgiq:-}" ] && [ -n "${brand_assessment:-}" ] && [ "$brand_orgiq" != "$brand_assessment" ] && ok "tenants carry different brands" || fail "tenant brands identical or missing"

section "shell"
L=portal/src/components/shell/Layout.tsx
grep -q 'data-shell-nav' "$L" && grep -qE '\[data-shell-nav\]' "$CSS" && ok "nav host marked and painted from tokens" || fail "Layout.tsx needs data-shell-nav and app.css a [data-shell-nav] rule"
grep -q 'shell-header' "$L" && grep -qE '\.shell-header' "$CSS" && ok "header marked and painted from tokens" || fail "Layout.tsx needs className shell-header and app.css a .shell-header rule"
grep -qE '^body *\{' "$CSS" && awk '/^body *\{/{f=1} f&&/background/{print; exit}' "$CSS" | grep -q 'var(--color-bg)' && ok "body paints --color-bg" || fail "body must paint var(--color-bg)"

section "pages use tokens, not a palette"
PAGES=portal/src/pages
n_pal=$(grep -rhoE "bg-(white|black|slate|gray|red|purple|indigo|blue|green|emerald|amber|yellow|orange|violet)(-[0-9]+)?\b" "$PAGES" | wc -l | tr -d ' ')
[ "$n_pal" = 0 ] && ok "no raw Tailwind palette backgrounds in pages" || { fail "raw palette classes in pages: $n_pal"; grep -rnoE "bg-(white|black|slate|gray|red|purple|indigo|blue|green|emerald|amber|yellow|orange|violet)(-[0-9]+)?\b" "$PAGES" | head -6 | sed 's/^/      /'; }
BUDGET_FILE=scripts/branding-hex-budget.txt; BUDGET_START=109
n_hex=$(grep -rhoE '#[0-9a-fA-F]{6}\b' "$PAGES" | wc -l | tr -d ' ')
budget=$(cat "$BUDGET_FILE" 2>/dev/null | tr -d ' \n'); [ -z "$budget" ] && { fail "$BUDGET_FILE missing"; budget=$BUDGET_START; }
[ "$budget" -le "$BUDGET_START" ] || fail "hex budget raised above $BUDGET_START"
[ "$n_hex" -le "$budget" ] && ok "hex literals in pages: $n_hex ≤ budget $budget" || fail "hex literals in pages: $n_hex > budget $budget"
[ "$budget" = 0 ] && ok "hex budget at the done line (0)" || { fail "hex budget $budget above the done line 0"; printf '      worst files:\n'; grep -rcE '#[0-9a-fA-F]{6}\b' "$PAGES" | grep -v ':0$' | sort -t: -k2 -rn | head -6 | sed 's/^/      /'; }

section "header rhythm (title, subtitle, breadcrumbs — one composite, one spacing)"
# Queued "Composed locally" frames (docs/ui-components-queue.md) are exempt — an
# xyflow node's count is not a page title.
QUEUED=$(grep -oE "Composed locally in \`portal/src/pages/[A-Za-z0-9_/.-]+\.tsx\`" docs/ui-components-queue.md 2>/dev/null | grep -oE "portal/src/pages/[A-Za-z0-9_/.-]+\.tsx" | sort -u)
TITLE_RE="text-(4xl|3xl|2xl|xl|\[[2-3][0-9]px\]|\[1[8-9]px\]) font-(semibold|bold)"
n_title=$(find "$PAGES" -name '*.tsx' | grep -vxF -f <(printf '%s\n' $QUEUED) | xargs grep -hoE "$TITLE_RE" 2>/dev/null | wc -l | tr -d ' ')
[ "$n_title" = 0 ] && ok "no page-level title typography (titles come from PageSection/PageHeader/CardHeader; stats from StatCard/StatStrip)" || { fail "pages styling their own titles: $n_title"; find "$PAGES" -name '*.tsx' | grep -vxF -f <(printf '%s\n' $QUEUED) | xargs grep -noE "$TITLE_RE" 2>/dev/null | head -5 | sed 's/^/      /'; }
n_hdr_sp=$(grep -rnoE "<(PageSection|PageHeader)[^>]*className=\"[^\"]*\b[mp][tblrxy]?-[0-9]" "$PAGES" | wc -l | tr -d ' ')
[ "$n_hdr_sp" = 0 ] && ok "no PageSection/PageHeader carries its own margin/padding" || fail "PageSection/PageHeader with ad-hoc spacing: $n_hdr_sp"
B=portal/src/components/shell/Breadcrumbs.tsx
# The shell's trail is `<Breadcrumbs />` (no props); the assessment explorer's
# `<Breadcrumbs items=…>` is the library's in-page crumb, a different thing.
# The nested pane was a second <main> until ui-components 2.273.0 (SubNavLayout
# contentAs="section"); the reset now targets the pane's own class. Either
# spelling satisfies the rule: the pane must inherit the shell's one padding.
grep -qE '\[data-shell-nav\] > div > main (main|\.flex-1\.min-w-0\.overflow-auto\.p-6)' "$CSS" && ok "nested section layouts inherit the shell's one content padding" || fail "app.css must reset the nested SubNavLayout pane's padding ([data-shell-nav] > div > main main, or its content-pane class) so nested titles sit at the plain-page offset"
grep -qE 'mb-4' "$B" && [ "$(grep -rhoE '<Breadcrumbs */>' portal/src | wc -l | tr -d ' ')" = 1 ] && grep -q '<Breadcrumbs />' "$L" && ok "shell breadcrumbs rendered once, by Layout.tsx, with one spacing rule" || fail "the shell's <Breadcrumbs /> must be rendered once by Layout.tsx with its spacing set in Breadcrumbs.tsx"
grep -qE 'className="h-full( flex flex-col)? bg-bg"' "$L" && ! grep -q 'fullBleed' "$L" && ok "the shell's content column adds no padding of its own (SubNavLayout's is the one)" || fail "Layout.tsx content column must not pad (no p-6, no fullBleed list) — SubNavLayout's content-pane padding is the single one"

section "builds"
if [ "$QUICK" = 0 ]; then
  (cd portal && npx tsc --noEmit >/dev/null 2>&1) && ok "portal tsc" || fail "portal tsc errors"
  (cd portal && npx vite build >/dev/null 2>&1) && ok "portal vite build" || fail "portal vite build failed"
fi


# ── Freshness is about CONTENT, not mtime ────────────────────────────────
# See docs/orgiq-journeys/PROTOCOL.md § "Freshness is about content": a bulk
# operation on 2026-09-07 stamped 134 portal files with one identical mtime
# while changing none of them, and logs "went stale" against edits that never
# happened. A digest that moves is a change; an mtime alone is not.
SHA_CACHE=docs/branding-journeys/.pages-sha
theme_sha() { printf '%s' "$(shasum -a 256 "$CSS" "$L" 2>/dev/null)" | shasum -a 256 | cut -d' ' -f1; }
sha_recorded() { grep -F "$1 " "$SHA_CACHE" 2>/dev/null | tail -1 | cut -d' ' -f2; }
sha_record() {
  [ -f "$SHA_CACHE" ] || : > "$SHA_CACHE"
  grep -vF "$1 " "$SHA_CACHE" > "$SHA_CACHE.tmp" 2>/dev/null || : > "$SHA_CACHE.tmp"
  printf '%s %s\n' "$1" "$2" >> "$SHA_CACHE.tmp"
  sort -o "$SHA_CACHE" "$SHA_CACHE.tmp" && rm -f "$SHA_CACHE.tmp"
}
section "journeys (docs/branding-journeys)"
J=docs/branding-journeys
for cell in orgiq-light orgiq-dark assessment-light assessment-dark; do
  f="$J/$cell.md"; if [ ! -f "$f" ]; then fail "$cell.md missing"; continue; fi
  bad=""
  grep -qiE '^verdict: *pass' "$f" || bad="$bad verdict"
  grep -qiE '^console errors: *0' "$f" || bad="$bad console"
  lay=$(grep -iE '^layers:' "$f" | head -1)
  nl=$(echo "$lay" | grep -oE '#[0-9a-fA-F]{6}|rgb\([^)]*\)' | tr 'A-F' 'a-f' | sort -u | wc -l | tr -d ' ')
  # body (ground) / nav (panel) / card (surface) must be three different tones;
  # header shares surface with a card and a panel shares the nav's tone.
  [ "$nl" -ge 3 ] || bad="$bad layers(${nl}-distinct,need-3)"
  cr=$(grep -iE '^contrast:' "$f" | sed -E 's/:1([^0-9]|$)/\1/g' | grep -oE '[0-9]+(\.[0-9]+)?' | sort -n | head -1)
  { [ -n "$cr" ] && awk -v c="$cr" 'BEGIN{exit !(c>=4.5)}'; } || bad="$bad contrast(${cr:-missing})"
  grep -qiE '^brand: *#[0-9a-fA-F]{6}' "$f" || bad="$bad brand"
  # rhythm: ≥ 6 "surface=<title-top − breadcrumb-bottom>px" entries, spread ≤ 2px, one title size.
  rl=$(grep -iE '^rhythm:' "$f" | head -1)
  offs=$(echo "$rl" | grep -oE '=[0-9]+px' | tr -d '=px'); nr=$(echo "$offs" | grep -c .)
  if [ "$nr" -lt 6 ]; then bad="$bad rhythm(${nr}-surfaces,need-6)"; else
    mn=$(echo "$offs" | sort -n | head -1); mx=$(echo "$offs" | sort -n | tail -1)
    [ $((mx-mn)) -le 2 ] || bad="$bad rhythm(spread-$((mx-mn))px)"
    sizes=$(echo "$rl" | grep -oE 'title [0-9]+px' | sort -u | wc -l | tr -d ' '); [ "$sizes" = 1 ] || bad="$bad rhythm(title-sizes-$sizes)"
  fi
  shot=$(grep -iE '^screenshot:' "$f" | head -1 | sed -E 's/^screenshot: *//'); { [ -n "$shot" ] && [ -f "$J/$shot" ]; } || bad="$bad screenshot"
  cur_sha=$(theme_sha)
  { [ "$f" -nt "$CSS" ] && [ "$f" -nt "$L" ]; } || [ "$(sha_recorded "$f")" = "$cur_sha" ] || bad="$bad stale"
  { [ -n "$bad" ] && [ "$SEAL" != 1 ]; } || sha_record "$f" "$cur_sha"
  grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad TODO"
  [ -z "$bad" ] && ok "$cell" || fail "$cell:$bad"
done

section "docs"
[ -f docs/branding.md ] && grep -q -- '--color-surface-panel' docs/branding.md && ok "docs/branding.md documents the layers" || fail "docs/branding.md missing or does not document the layers"

echo; if [ "${#FAILS[@]}" = 0 ]; then echo "ALL CHECKS PASS — the branding system meets its definition of done."; exit 0; fi
printf '%d CHECK(S) FAILING:\n' "${#FAILS[@]}"; for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done; exit 1
