import json
import unittest
from evidence_commands import validate_evidence_output

EV = [{'id': 'EV-1', 'excerpt': 'CI runs on every merge.', 'supports_level': 2},
      {'id': 'EV-2', 'excerpt': 'Deploys are manual.\nNo rollback plan.', 'supports_level': 1}]
CRIT = [{'id': 'c1', 'text': 'Automated rollback is exercised.'}, {'id': 'c2', 'text': 'Release is fully automated.'}]
D = {'id': '7', 'title': 'Release', 'facts': {'verified_level': 2, 'target_level': 3, 'claimed_level': 3},
     'criteria': CRIT, 'evidence': EV, 'existing_questions': ['Who owns release?']}
PAYLOAD = {'dimension': D}


def run(mode, value):
    raw = value if isinstance(value, str) else json.dumps(value)
    return json.loads(validate_evidence_output(mode, raw, PAYLOAD))


def span(i=0, text=None):
    return {'evidenceId': EV[i]['id'], 'text': text or EV[i]['excerpt'].split('\n')[0]}


class SummarizeTests(unittest.TestCase):
    def test_valid_summary_kept_and_marked_unpublished_draft(self):
        out = run('summarize-evidence', {'summary': 'Level 2 verified.', 'bullets': [
            {'text': 'CI runs on merge (verified level 2).', 'source_spans': [span(0)]}]})
        self.assertFalse(out['fallback'])
        self.assertIs(out['draft'], True)
        self.assertIs(out['published'], False)
        self.assertEqual(out['summary'], 'Level 2 verified.')

    def test_non_verbatim_span_or_invented_number_falls_back(self):
        for bullet in ({'text': 'Fine.', 'source_spans': [span(0, 'made up')]},
                       {'text': 'Coverage is 97 percent.', 'source_spans': [span(0)]},
                       {'text': 'No spans.', 'source_spans': []},
                       {'text': 'Wrong id.', 'source_spans': [{'evidenceId': 'EV-9', 'text': 'x'}]}):
            with self.subTest(bullet=bullet):
                out = run('summarize-evidence', {'summary': 's', 'bullets': [bullet]})
                self.assertTrue(out['fallback'])
                for b in out['bullets']:
                    for s in b['source_spans']:
                        self.assertIn(s['text'], {e['id']: e['excerpt'] for e in EV}[s['evidenceId']])

    def test_invented_number_in_summary_replaced(self):
        out = run('summarize-evidence', {'summary': 'Reached level 5.', 'bullets': [
            {'text': 'CI runs on merge.', 'source_spans': [span(0)]}]})
        self.assertFalse(out['fallback'])
        self.assertNotIn('5', out['summary'])

    def test_garbage_and_no_evidence(self):
        self.assertTrue(run('summarize-evidence', 'not json')['fallback'])
        empty = json.loads(validate_evidence_output('summarize-evidence', '{}', {'dimension': {'id': '7', 'evidence': []}}))
        self.assertEqual(empty['bullets'], [])
        self.assertIn('no evidence', empty['summary'].lower())


class FollowupTests(unittest.TestCase):
    def q(self, text, cid='c1', spans=None):
        return {'text': text, 'criterionId': cid, 'source_spans': spans or []}

    def test_valid_questions_kept_and_deduped_against_existing(self):
        out = run('draft-followups', {'summary': 'Two questions.', 'questions': [
            self.q('How often is rollback exercised?'), self.q('who owns release?'),
            self.q('Is the pipeline gated?', cid=None, spans=[span(0)]),
            self.q('How often is rollback exercised?')]})
        self.assertFalse(out['fallback'])
        self.assertEqual([x['text'] for x in out['questions']],
                         ['How often is rollback exercised?', 'Is the pipeline gated?'])

    def test_ungrounded_questions_dropped_then_criteria_fallback(self):
        out = run('draft-followups', {'questions': [
            self.q('Not a question.'), self.q('Is it 97 percent?'), self.q('No anchor?', cid='nope'),
            self.q('Bad quote?', cid=None, spans=[span(0, 'made up')])]})
        self.assertTrue(out['fallback'])
        self.assertEqual([x['criterionId'] for x in out['questions']], ['c1', 'c2'])
        self.assertTrue(out['questions'][0]['text'].endswith('?'))

    def test_garbage_falls_back_and_nothing_to_ask_is_empty(self):
        self.assertTrue(run('draft-followups', '[]')['fallback'])
        out = json.loads(validate_evidence_output('draft-followups', 'x', {'dimension': {'id': '7', 'evidence': [], 'criteria': []}}))
        self.assertEqual(out['questions'], [])


if __name__ == '__main__':
    unittest.main()
