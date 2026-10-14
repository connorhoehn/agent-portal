#!/usr/bin/env python3
"""Count human-in-the-loop decisions asked in a modal instead of the composer deck.

Since ui-components 2.444.0 a page that needs a person's decision puts it in
the docked composer as a ComposerPromptDeck prompt (a header card of facts,
one question, numbered answers; `ConversationComposer prompts`). Prepare job
was the first (portal/src/pages/project-detail/usePrepareJobDeck.ts). A modal
asks the same question in a box over the page, away from the conversation and
the keyboard path, so new ones are a ratchet in validate-component-discipline.sh.

Usage:
  count-hitl-modals.py [root]          # "decisionmodal <n>" and "deck <n>"
  count-hitl-modals.py [root] --list   # also every file:line

decisionmodal  a `<ConfirmDialog` (a confirm-a-decision modal by definition),
               or a `<Modal` / `<Drawer` whose body holds a form control
               (Textarea, Input, NumberInput, Select, RadioGroup, Checkbox,
               Combobox) — a decision form in a box.
deck           a file that builds or hands over composer prompts (draws
               `<ComposerPromptDeck`, names the `ComposerPrompt` type, or calls
               a `use…Deck(` hook): reported, never failing.
Tests, stories and node_modules are skipped.
"""
import pathlib, re, sys

args = [a for a in sys.argv[1:] if not a.startswith('--')]
LIST = '--list' in sys.argv
root = pathlib.Path(args[0] if args else 'portal/src')

CONTROL = re.compile(r'<(?:Textarea|Input|NumberInput|Select|RadioGroup|Checkbox|Combobox)(?=[\s/>])')
OPEN = re.compile(r'<(ConfirmDialog|Modal|Drawer)(?=[\s/>])')
DECK = re.compile(r'<ComposerPromptDeck(?=[\s/>])|\bComposerPrompt\b|\buse\w*Deck\(')

def line_of(s, i):
    return s.count('\n', 0, i) + 1

hits = {'decisionmodal': [], 'deck': []}
for f in sorted(root.rglob('*.tsx')):
    p = str(f)
    if '/node_modules/' in p or '.test.' in p or '.stories.' in p or '/__tests__/' in p:
        continue
    s = f.read_text(encoding='utf-8', errors='ignore')
    for m in OPEN.finditer(s):
        name = m.group(1)
        if name == 'ConfirmDialog':
            hits['decisionmodal'].append(f'{p}:{line_of(s, m.start())}')
            continue
        close = s.find(f'</{name}>', m.end())
        if close > 0 and CONTROL.search(s, m.end(), close):
            hits['decisionmodal'].append(f'{p}:{line_of(s, m.start())}')
    if DECK.search(s):
        hits['deck'].append(p)

for k, v in hits.items():
    print(f'{k} {len(v)}')
    if LIST:
        for h in v:
            print(f'    {h}')
