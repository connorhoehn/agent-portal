import json
import unittest
from agent_plan import validate_agent_plan

PAYLOAD = {'goal': 'Wrap up the release thread', 'allowed_kinds': ['summarize', 'diagram', 'doc', 'draft', 'note']}


def run(value):
    raw = value if isinstance(value, str) else json.dumps(value)
    return json.loads(validate_agent_plan('plan-agent-loop', raw, PAYLOAD))


def step(kind='summarize', **over):
    return {'kind': kind, 'title': 'Summarize', 'instruction': 'last day', 'acceptance': 'A summary quotes the thread.', **over}


class PlanTests(unittest.TestCase):
    def test_valid_plan_kept(self):
        out = run({'summary': 'Two steps.', 'steps': [step(), step('diagram')]})
        self.assertFalse(out['fallback'])
        self.assertEqual([s['kind'] for s in out['steps']], ['summarize', 'diagram'])

    def test_disallowed_kind_falls_back(self):
        self.assertTrue(run({'summary': 'x', 'steps': [step('deck')]})['fallback'])

    def test_invented_kind_falls_back(self):
        self.assertTrue(run({'summary': 'x', 'steps': [step('box:run')]})['fallback'])

    def test_creation_kinds_only_where_allowed(self):
        # Not in this payload's allowed_kinds, so the plan falls back.
        self.assertTrue(run({'summary': 'x', 'steps': [step('meeting:create')]})['fallback'])
        self.assertTrue(run({'summary': 'x', 'steps': [step('document:create')]})['fallback'])
        payload = {'goal': 'g', 'allowed_kinds': ['document:create', 'meeting:create', 'note']}
        raw = json.dumps({'summary': 's', 'steps': [step('document:create', body='# T\r\n\x00text ' + 'x' * 5000), step('meeting:create', body='ignored')]})
        out = json.loads(validate_agent_plan('plan-agent-loop', raw, payload))
        self.assertFalse(out['fallback'])
        self.assertTrue(out['steps'][0]['body'].startswith('# T\ntext'))
        self.assertEqual(len(out['steps'][0]['body']), 4000)
        self.assertNotIn('body', out['steps'][1])

    def test_approval_gates_a_later_step_and_is_never_last(self):
        payload = {'goal': 'g', 'allowed_kinds': ['summarize', 'doc', 'approval', 'note']}
        good = json.dumps({'summary': 's', 'steps': [step('summarize'), step('approval', instruction='Post the page?'), step('doc')]})
        out = json.loads(validate_agent_plan('plan-agent-loop', good, payload))
        self.assertFalse(out['fallback'])
        self.assertEqual([s['kind'] for s in out['steps']], ['summarize', 'approval', 'doc'])
        last = json.dumps({'summary': 's', 'steps': [step('summarize'), step('approval')]})
        self.assertTrue(json.loads(validate_agent_plan('plan-agent-loop', last, payload))['fallback'])

    def test_more_than_six_steps_falls_back(self):
        self.assertTrue(run({'summary': 'x', 'steps': [step() for _ in range(7)]})['fallback'])

    def test_missing_acceptance_falls_back(self):
        self.assertTrue(run({'summary': 'x', 'steps': [step(acceptance='')]})['fallback'])

    def test_not_json_falls_back_without_raising(self):
        out = run('not json')
        self.assertTrue(out['fallback'])
        self.assertEqual(len(out['steps']), 1)


if __name__ == '__main__':
    unittest.main()
