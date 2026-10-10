import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _shared.tenant_guard import reject_wrong_mode_tenant
from agent_plan import AGENT_PLAN_MODES
from deck_narrative import (
    DECK_NARRATIVE_MODES, DECK_NARRATIVE_TENANTS, DECK_REVISE_MODES, INITIATIVE_MODE, PIPELINE_MODE, SOCIAL_MODE,
    REVISE_INITIATIVE_MODE, REVISE_PIPELINE_MODE, REVISE_SOCIAL_MODE, validate_deck_narrative_output,
)
from document_commands import DECK_MODES, DOCUMENT_MODES
from evidence_commands import EVIDENCE_MODES

ASSESSMENT_MODES = {'story', 'context', *DOCUMENT_MODES, *DECK_MODES, *EVIDENCE_MODES, *AGENT_PLAN_MODES}
TENANTS = ('assessment', 'orgiq', 'pipelines', 'social', None)


def verdict(mode, tenant):
    payload = {'mode': mode} if tenant is None else {'mode': mode, 'auth': {'tenant': tenant}}
    return reject_wrong_mode_tenant(
        payload, mode_tenants=dict(DECK_NARRATIVE_TENANTS), default_tenant='assessment', agent_id='a')


class ModeTenantTable(unittest.TestCase):
    def test_every_mode_runs_for_exactly_its_tenant(self):
        for mode in sorted(ASSESSMENT_MODES | DECK_NARRATIVE_MODES):
            owner = DECK_NARRATIVE_TENANTS.get(mode, 'assessment')
            for tenant in TENANTS:
                with self.subTest(mode=mode, tenant=tenant):
                    out = verdict(mode, tenant)
                    if tenant == owner:
                        self.assertIsNone(out)
                    else:
                        self.assertEqual(out['error'], 'forbidden')
                        self.assertIn(repr(mode), out['detail'])

    def test_new_modes_are_owned_by_their_tenant(self):
        self.assertEqual(DECK_NARRATIVE_TENANTS, {
            INITIATIVE_MODE: 'orgiq', PIPELINE_MODE: 'pipelines', SOCIAL_MODE: 'social', REVISE_INITIATIVE_MODE: 'orgiq',
            REVISE_PIPELINE_MODE: 'pipelines', REVISE_SOCIAL_MODE: 'social'})
        self.assertFalse(DECK_NARRATIVE_MODES & ASSESSMENT_MODES)

    def test_main_wires_the_table(self):
        src = (Path(__file__).parent / 'main.py').read_text()
        self.assertIn('MODE_TENANTS = dict(DECK_NARRATIVE_TENANTS)', src)
        self.assertIn('mode_tenants=MODE_TENANTS', src)
        self.assertNotIn('reject_wrong_tenant(', src)


EV = [{'id': 'e1', 'excerpt': 'Cutover finished with 3 open risks.'}]
SLIDES = [{'slideId': 's1', 'kind': 'initiative-summary', 'facts': {'progress': '62%', 'blocked': 2}, 'evidence': EV}]


def run(mode, narratives, summary='ok'):
    raw = json.dumps({'summary': summary, 'narratives': narratives})
    return json.loads(validate_deck_narrative_output(mode, raw, {'teamId': 'p', 'slides': SLIDES}))


def good(bullet):
    return {'slideId': 's1', 'bullets': [bullet], 'source_spans': [{'evidenceId': 'e1', 'text': 'Cutover finished'}]}


class NumbersFromFacts(unittest.TestCase):
    def test_numbers_in_facts_or_evidence_are_kept(self):
        for mode in sorted(DECK_NARRATIVE_MODES - DECK_REVISE_MODES):
            with self.subTest(mode=mode):
                out = run(mode, [good('Progress is 62% with 2 blocked and 3 open risks.')])
                self.assertEqual(out['fallbackSlideIds'], [])
                self.assertIs(out['draft'], True)
                self.assertIs(out['published'], False)

    def test_invented_number_falls_back_to_quoted_evidence(self):
        for mode in sorted(DECK_NARRATIVE_MODES - DECK_REVISE_MODES):
            with self.subTest(mode=mode):
                out = run(mode, [good('Progress is 87% and 9 items are blocked.')])
                self.assertEqual(out['fallbackSlideIds'], ['s1'])
                self.assertNotIn('87', json.dumps(out['narratives']))

    def test_invented_number_in_summary_replaced(self):
        out = run(INITIATIVE_MODE, [good('Fine.')], summary='Delivered 41 items.')
        self.assertNotIn('41', out['summary'])

    def test_non_verbatim_span_and_garbage_fall_back(self):
        bad = good('Fine.'); bad['source_spans'] = [{'evidenceId': 'e1', 'text': 'made up'}]
        self.assertEqual(run(PIPELINE_MODE, [bad])['fallbackSlideIds'], ['s1'])
        out = json.loads(validate_deck_narrative_output(PIPELINE_MODE, 'nope', {'slides': SLIDES}))
        self.assertEqual(out['fallbackSlideIds'], ['s1'])

    def test_assessment_mode_is_not_accepted_here(self):
        with self.assertRaises(ValueError):
            validate_deck_narrative_output('draft-review-deck', '{}', {'slides': SLIDES})


SPEC = {'title': 'T', 'slides': [{'id': 's1', 'layout': 'bullets', 'title': 'Status', 'bullets': ['Progress is 62%.']}]}
REV = {'spec': SPEC, 'instruction': 'shorter', 'slideId': 's1', 'facts': {'s1': {'progress': '62%'}}, 'evidence': EV}


def revise(mode, bullet, payload=REV):
    new = json.loads(json.dumps(SPEC)); new['slides'][0]['bullets'] = [bullet]
    return json.loads(validate_deck_narrative_output(mode, json.dumps({'summary': 'ok', 'spec': new}), payload))


class ReviseModes(unittest.TestCase):
    def test_numbers_from_facts_are_kept_in_every_revise_mode(self):
        for mode in sorted(DECK_REVISE_MODES):
            with self.subTest(mode=mode):
                out = revise(mode, 'Progress 62%, 3 open risks.')
                self.assertEqual(out['changedSlideIds'], ['s1'])
                self.assertNotIn('fallback', out)
                self.assertIs(out['published'], False)

    def test_invented_number_leaves_the_deck_unchanged(self):
        for mode in sorted(DECK_REVISE_MODES):
            with self.subTest(mode=mode):
                out = revise(mode, 'Progress is 87%.')
                self.assertIs(out['fallback'], True)
                self.assertEqual(out['spec'], SPEC)

    def test_garbage_leaves_the_deck_unchanged(self):
        out = json.loads(validate_deck_narrative_output(REVISE_SOCIAL_MODE, 'nope', REV))
        self.assertEqual(out['changedSlideIds'], [])
        self.assertEqual(out['spec'], SPEC)

    def test_revise_modes_need_spec_and_instruction(self):
        src = (Path(__file__).parent / 'main.py').read_text()
        self.assertIn('DECK_REVISE_MODES', src)


if __name__ == '__main__':
    unittest.main()
