import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _shared.tenant_guard import reject_wrong_mode_tenant
from deck_narrative import DECK_NARRATIVE_TENANTS
from deck_operations import (
    DECK_OPERATIONS_MODES, DECK_OPERATIONS_TENANTS, MAX_OPERATIONS, OPERATE_INITIATIVE_MODE, OPERATE_REVIEW_MODE,
    OPERATE_SOCIAL_MODE, validate_deck_operations_output,
)

MODE_TENANTS = {**DECK_NARRATIVE_TENANTS, **DECK_OPERATIONS_TENANTS}
# The guard's explicit dev-mode trust path, as test_deck_narrative.py runs it.
_DEV_MODE = mock.patch.dict("os.environ", {"AGENT_INVOKE_SECRET": "", "AGENT_INVOKE_SECRET_ID": "",
                                           "INSECURE_DEV_MODE": "true", "NODE_ENV": "", "APP_ENV": ""})


def setUpModule():
    _DEV_MODE.start()


def tearDownModule():
    _DEV_MODE.stop()


def verdict(mode, tenant):
    return reject_wrong_mode_tenant({'mode': mode, 'auth': {'tenant': tenant}}, mode_tenants=MODE_TENANTS, default_tenant='assessment', agent_id='a')


class DeckOperationsModes(unittest.TestCase):
    def test_each_mode_runs_only_for_its_own_tenant(self):
        own = {OPERATE_REVIEW_MODE: 'assessment', OPERATE_INITIATIVE_MODE: 'orgiq', 'operate-pipeline-run-deck': 'pipelines', OPERATE_SOCIAL_MODE: 'social'}
        self.assertEqual(set(own), set(DECK_OPERATIONS_MODES))
        for mode, tenant in own.items():
            for other in ('assessment', 'orgiq', 'pipelines', 'social'):
                rejected = verdict(mode, other) is not None
                self.assertEqual(rejected, other != tenant, (mode, other))

    def test_keeps_the_reply_and_well_formed_operations_only(self):
        answer = json.dumps({'reply': 'Changing slide 3.', 'operations': [{'op': 'change_layout', 'slideId': 's3', 'layout': 'kpi'}, 'junk', {'no': 'op'}]})
        out = json.loads(validate_deck_operations_output(OPERATE_SOCIAL_MODE, answer))
        self.assertEqual(out, {'reply': 'Changing slide 3.', 'operations': [{'op': 'change_layout', 'slideId': 's3', 'layout': 'kpi'}]})

    def test_caps_the_list_and_reads_a_fenced_or_wrapped_answer(self):
        ops = [{'op': 'set_style', 'style': 'bold'}] * (MAX_OPERATIONS + 3)
        fenced = '```json\n' + json.dumps({'reply': 'ok', 'operations': ops}) + '\n```'
        self.assertEqual(len(json.loads(validate_deck_operations_output(OPERATE_SOCIAL_MODE, fenced))['operations']), MAX_OPERATIONS)
        wrapped = 'Here you go: ' + json.dumps({'reply': 'ok', 'operations': []})
        self.assertEqual(json.loads(validate_deck_operations_output(OPERATE_SOCIAL_MODE, wrapped))['reply'], 'ok')

    def test_an_unreadable_answer_is_a_reply_with_nothing_to_apply(self):
        out = json.loads(validate_deck_operations_output(OPERATE_INITIATIVE_MODE, 'not json'))
        self.assertEqual(out['operations'], [])
        with self.assertRaises(ValueError):
            validate_deck_operations_output('story', '{}')


if __name__ == '__main__':
    unittest.main()
