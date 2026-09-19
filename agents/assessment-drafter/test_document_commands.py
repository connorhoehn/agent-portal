import json
import unittest
from document_commands import validate_document_output

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
