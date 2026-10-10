import json
import unittest
from document_commands import DOCUMENT_PROMPT, validate_document_output

SOURCE = 'The pipeline checks every change.'


def result(content, fmt='markdown', spans=None):
    return json.dumps({'summary': 'Draft ready', 'content': content, 'format': fmt,
                       'source_spans': [SOURCE] if spans is None else spans})


class DocumentCommandsTests(unittest.TestCase):
    def test_all_four_modes_produce_explicit_unpublished_drafts(self):
        examples = {
            'draft-confluence-page': result('# Pipeline\n' + SOURCE),
            'suggest-confluence-content': result('Proposed: add pipeline ownership.'),
            'validate-outputs': result(json.dumps({'findings': [{'message': 'A check is described.', 'source_span': SOURCE}]}), 'json'),
            'draw-diagram': result('<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>', 'drawio'),
        }
        for mode, raw in examples.items():
            with self.subTest(mode=mode):
                output = json.loads(validate_document_output(mode, raw, SOURCE))
                self.assertIs(output['draft'], True)
                self.assertIs(output['published'], False)

    def test_suggestion_blocks_are_reviewable_one_by_one(self):
        # The portal reviews a suggestion per blank-line-separated block (slice 9).
        self.assertIn('own block', DOCUMENT_PROMPT)
        self.assertIn('separated by a blank line', DOCUMENT_PROMPT)
        raw = result('First point.\n\nSecond point.')
        output = json.loads(validate_document_output('suggest-confluence-content', raw, SOURCE))
        self.assertEqual(output['content'].split('\n\n'), ['First point.', 'Second point.'])

    def test_fabricated_source_quotes_fail_closed(self):
        with self.assertRaises(ValueError):
            validate_document_output('draft-confluence-page', result('draft', spans=['made up']), SOURCE)

    def test_unsafe_diagram_xml_fails_closed(self):
        for xml in (
            '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><mxGraphModel><root/></mxGraphModel>',
            '<mxGraphModel><root><script/></root></mxGraphModel>',
            '<mxGraphModel><root><mxCell style="html=1" value="&lt;script&gt;"/></root></mxGraphModel>',
            '<mxGraphModel><root><mxCell style="image=https://evil.example/pixel"/></root></mxGraphModel>',
            '<mxGraphModel><root><mxCell link="javascript:alert(1)"/></root></mxGraphModel>',
            '<broken',
        ):
            with self.subTest(xml=xml), self.assertRaises(ValueError):
                validate_document_output('draw-diagram', result(xml, 'drawio'), SOURCE)

    def test_missing_or_wrong_shape_refused(self):
        for raw in ('not JSON', '[]', '{}', result('text', 'html')):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                validate_document_output('draft-confluence-page', raw, SOURCE)


class DeckCommandsTests(unittest.TestCase):
    from document_commands import validate_deck_output as _v
    EV = [{'id': 'e1', 'excerpt': 'CI runs on every merge.'}]
    SLIDES = [{'slideId': 's1', 'kind': 'dimension', 'facts': {'verified': 2, 'target': 3}, 'evidence': EV},
              {'slideId': 's2', 'kind': 'next', 'facts': {}, 'evidence': EV}]

    def draft(self, narratives, summary='Fine'):
        raw = json.dumps({'summary': summary, 'narratives': narratives})
        return json.loads(validate_document_output.__globals__['validate_deck_output'](
            'draft-review-deck', raw, {'teamId': 't', 'slides': self.SLIDES}))

    def good(self, sid, bullet='Verified level 2 of target 3.'):
        return {'slideId': sid, 'bullets': [bullet], 'source_spans': [{'evidenceId': 'e1', 'text': 'CI runs on every merge.'}]}

    def test_valid_draft_kept(self):
        out = self.draft([self.good('s1'), self.good('s2', 'Keep CI.')])
        self.assertEqual(out['fallbackSlideIds'], [])
        self.assertEqual(out['narratives'][0]['bullets'], ['Verified level 2 of target 3.'])

    def test_non_verbatim_span_or_invented_number_falls_back(self):
        bad = self.good('s1'); bad['source_spans'] = [{'evidenceId': 'e1', 'text': 'made up'}]
        out = self.draft([bad, self.good('s2', 'Coverage is 97 percent.')])
        self.assertEqual(out['fallbackSlideIds'], ['s1', 's2'])
        for n in out['narratives']:
            self.assertTrue(all(s['text'] in self.EV[0]['excerpt'] for s in n['source_spans']))

    def test_garbage_and_missing_slides_fall_back(self):
        out = json.loads(validate_document_output.__globals__['validate_deck_output'](
            'draft-review-deck', 'not json', {'slides': self.SLIDES}))
        self.assertEqual(len(out['narratives']), 2)
        self.assertEqual(out['fallbackSlideIds'], ['s1', 's2'])

    def revise(self, new_spec, facts=None, **extra):
        spec = {'slides': [{'id': 'a', 'layout': 'bullets', 'title': 'Old 2', 'bullets': ['x'], 'sources': [], 'chart': {'v': 1}},
                           {'id': 'b', 'layout': 'bullets', 'title': 'B', 'sources': []}]}
        payload = {'spec': spec, 'instruction': 'x', 'facts': facts or {}, 'evidence': self.EV, **extra}
        raw = json.dumps({'summary': 'Done', 'spec': new_spec, 'source_spans': [
            {'evidenceId': 'e1', 'text': 'CI runs on every merge.'}, {'evidenceId': 'e1', 'text': 'nope'}]})
        return json.loads(validate_document_output.__globals__['validate_deck_output']('revise-review-deck', raw, payload))

    def spec(self, a=None, b=None):
        sa = {'id': 'a', 'layout': 'bullets', 'title': 'Old 2', 'bullets': ['x'], 'sources': [], 'chart': {'v': 1}}
        sb = {'id': 'b', 'layout': 'bullets', 'title': 'B', 'sources': []}
        return {'slides': [dict(sa, **(a or {})), dict(sb, **(b or {}))]}

    def test_revise_accepts_scoped_edit_and_strips_bad_span(self):
        out = self.revise(self.spec(a={'bullets': ['Level 3 is the target']}), facts={'a': {'target': 3}}, slideId='a')
        self.assertEqual(out['changedSlideIds'], ['a'])
        self.assertEqual(len(out['source_spans']), 1)

    def test_revise_rejects_invented_number_and_protected_or_scope_changes(self):
        cases = ((self.spec(a={'bullets': ['Level 7']}), {}),
                 (self.spec(a={'layout': 'title'}), {}),
                 (self.spec(a={'sources': [{'documentId': 'd'}]}), {}),
                 (self.spec(a={'chart': {'v': 2}}), {}),
                 ({'slides': [{'id': 'z'}]}, {}),
                 (self.spec(b={'title': 'Changed'}), {'slideId': 'a'}))
        for spec, extra in cases:
            with self.subTest(spec=spec):
                out = self.revise(spec, **extra)
                self.assertTrue(out['fallback'])
                self.assertEqual(out['changedSlideIds'], [])


class SummarizeConversationTests(unittest.TestCase):
    TRANSCRIPT = 'Theo Chang: Is the Thursday call still on?\nMira Okafor: Yes, same time, same room.'

    def run_mode(self, **over):
        value = {'summary': 'The call is on.', 'content': '## Summary\nThe Thursday call stays.', 'format': 'markdown',
                 'source_spans': ['Yes, same time, same room.'], **over}
        return validate_document_output('summarize-conversation', json.dumps(value), self.TRANSCRIPT)

    def test_accepts_verbatim_single_message_quotes_as_unpublished_draft(self):
        out = json.loads(self.run_mode())
        self.assertIs(out['draft'], True)
        self.assertIs(out['published'], False)

    def test_rejects_invented_quote_missing_quotes_and_line_spanning_quotes(self):
        for spans in (['Friday it is'], [], ['Is the Thursday call still on?\nMira Okafor: Yes'], ['Yes, same time, same room.'] * 13):
            with self.subTest(spans=spans), self.assertRaises(ValueError):
                self.run_mode(source_spans=spans)

    def test_rejects_oversized_content(self):
        with self.assertRaises(ValueError):
            self.run_mode(content='x' * 4001)
