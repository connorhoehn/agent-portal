"""One knowledge base holds every tenant's documents; a retrieve returns only the caller's.

Ownership is the registry's: the longest registered knowledge-base prefix a
document's key starts with names its tenant, the home tenant's (orgiq) corpus
is registered explicitly in code, and a key no prefix matches belongs to no one. Both read agents (search, advisor) filter every
retrieve to the tenant they were invoked for, and a registry that cannot be
read returns nothing rather than everything.

Run:  cd agents/tests && python -m unittest test_kb_tenant_filter
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import load_agent  # noqa: E402
from _shared import kb_resolver as kb  # noqa: E402

SECRET = "invoke-secret-for-tests-0123456789"


def signed(auth: dict, conversation: str, service_id: str | None = None) -> dict:
    from _shared import invoke_auth
    from _shared.callbacks import sign_service_request

    sig = sign_service_request(
        invoke_auth.METHOD, invoke_auth.TARGET, invoke_auth.canonical_body(auth, conversation),
        secret=SECRET, service_id=service_id or invoke_auth.SERVICE_ID, audience=invoke_auth.AUDIENCE,
    )
    return {"input_text": "q", "auth": auth, "sessionId": conversation, "authSig": sig}


PREFIXES = [("assessment/evidence/", "assessment"), ("orgiq/uploads/", "orgiq"), ("social/", "social")]
BUCKET = "s3://orgiq-documents-111111111111-us-east-1/"


def hit(key: str) -> dict:
    return {"content": {"text": key}, "score": 0.5, "location": {"s3Location": {"uri": BUCKET + key}}}


HITS = [hit("synth/internal/adr/adr-d-aurora.md"), hit("assessment/evidence/acme/report.md"),
        hit("orgiq/uploads/2026-11-01/notes.md"), hit("social/threads/t1.md")]


class Ownership(unittest.TestCase):
    def test_longest_prefix_wins_and_the_home_corpus_is_declared(self):
        self.assertEqual(kb.document_owner(BUCKET + "assessment/evidence/a.md", PREFIXES), "assessment")
        self.assertEqual(kb.document_owner(BUCKET + "synth/internal/x.md", PREFIXES), "orgiq")
        nested = PREFIXES + [("social/private/", "orgiq")]
        self.assertEqual(kb.document_owner(BUCKET + "social/private/x.md", nested), "orgiq")
        self.assertEqual(kb.document_owner(BUCKET + "social/x.md", nested), "social")

    def test_filter_keeps_only_the_callers_documents(self):
        results = [{"source": BUCKET + k} for k in ("uploads/a.md", "assessment/evidence/b.md", "social/c.md")]
        self.assertEqual([r["source"] for r in kb.filter_for_tenant(results, "assessment", prefixes=PREFIXES)],
                         [BUCKET + "assessment/evidence/b.md"])
        self.assertEqual([r["source"] for r in kb.filter_for_tenant(results, "orgiq", prefixes=PREFIXES)],
                         [BUCKET + "uploads/a.md"])

    def test_a_key_no_prefix_matches_belongs_to_no_one(self):
        """It used to fall to the home tenant, so a parent prefix could capture it."""
        self.assertIsNone(kb.document_owner(BUCKET + "legacy/postmortem.md", PREFIXES))
        self.assertIsNone(kb.document_owner(BUCKET + "root.md", PREFIXES))
        for tenant in ("orgiq", "assessment", "social"):
            self.assertEqual(kb.filter_for_tenant([{"source": BUCKET + "legacy/x.md"}], tenant, prefixes=PREFIXES), [])

    def test_t1_is_not_t10_and_trailing_slashes_do_not_matter(self):
        rows = [("t1", "assessment"), ("t10/", "social")]
        self.assertEqual(kb.document_owner(BUCKET + "t1/a.md", rows), "assessment")
        self.assertEqual(kb.document_owner(BUCKET + "t10/a.md", rows), "social")
        self.assertIsNone(kb.document_owner(BUCKET + "t100/a.md", rows))

    def test_no_registered_prefix_means_everything_is_home(self):
        self.assertEqual(kb.document_owner(BUCKET + "legacy/x.md", []), "orgiq")

    def test_home_prefixes_match_the_middleware(self):
        import re
        ts = (Path(__file__).resolve().parents[2] / "middleware/src/lib/kb-prefixes.ts").read_text()
        listed = re.search(r"HOME_KB_PREFIXES: readonly string\[\] = \[([^\]]*)\]", ts).group(1)
        self.assertEqual(tuple(re.findall(r"'([^']+)'", listed)), kb.HOME_PREFIXES)

    def test_an_unreadable_registry_returns_nothing(self):
        with mock.patch.object(kb, "tenant_prefixes", return_value=None):
            self.assertEqual(kb.filter_for_tenant([{"source": BUCKET + "a.md"}], "orgiq"), [])

    def test_no_registry_configured_means_everything_is_home(self):
        with mock.patch.object(kb, "_CLUSTER_ARN", ""):
            self.assertEqual(kb.tenant_prefixes(), [])

    def test_caller_tenant_in_dev_mode_reads_only_the_auth_block(self):
        env = {"AGENT_INVOKE_SECRET": "", "AGENT_INVOKE_SECRET_ID": "", "INSECURE_DEV_MODE": "true",
               "NODE_ENV": "", "APP_ENV": ""}
        with mock.patch.dict("os.environ", env):
            self.assertEqual(kb.caller_tenant({"auth": {"tenant": "social"}}), "social")
            self.assertEqual(kb.caller_tenant({"tenant": "assessment"}), "orgiq")
            self.assertEqual(kb.caller_tenant({"auth": {"tenant": "orgiq"}, "tenant": "assessment"}), "orgiq")
            self.assertEqual(kb.caller_tenant({}), "orgiq")

    def test_caller_tenant_ignores_an_unsigned_tenant(self):
        """A member's payload naming another tenant, at the top level, under
        `input` or in an unsigned block, never changes the retrieval scope."""
        with mock.patch.dict("os.environ", {"AGENT_INVOKE_SECRET": SECRET, "INSECURE_DEV_MODE": ""}):
            member = signed({"sub": "u-1", "role": "member", "tenant": "orgiq"}, "conv-1")
            self.assertEqual(kb.caller_tenant(member), "orgiq")
            self.assertEqual(kb.caller_tenant({**member, "tenant": "assessment",
                                               "input": {"tenant": "assessment"}}), "orgiq")
            self.assertEqual(kb.caller_tenant({"auth": {"tenant": "assessment"}}), "orgiq")
            self.assertEqual(kb.caller_tenant({"tenant": "assessment"}), "orgiq")
            forged = {**member, "auth": {**member["auth"], "tenant": "assessment"}}
            self.assertEqual(kb.caller_tenant(forged), "orgiq")
            self.assertEqual(kb.caller_tenant(signed({"sub": "u-2", "tenant": "assessment"}, "conv-2")), "assessment")


class FakeBedrock:
    def __init__(self, results):
        self.results = results

    def retrieve(self, **kwargs):
        return {"retrievalResults": self.results}


class ReadAgentsFilter(unittest.TestCase):
    def _sources(self, agent_dir, tool, tenant):
        mod = load_agent(agent_dir)
        mod._bedrock = FakeBedrock(HITS)
        token = mod._caller_tenant.set(tenant)
        try:
            with mock.patch.object(kb, "tenant_prefixes", return_value=PREFIXES):
                out = json.loads(getattr(mod, tool)(query="anything"))
        finally:
            mod._caller_tenant.reset(token)
        return [r["source"].replace(BUCKET, "") for r in out]

    def test_both_read_agents_return_only_the_callers_documents(self):
        for agent_dir, tool in (("search", "query_knowledge_base"), ("advisor", "retrieve_context")):
            with self.subTest(agent=agent_dir):
                self.assertEqual(self._sources(agent_dir, tool, "orgiq"),
                                 ["synth/internal/adr/adr-d-aurora.md", "orgiq/uploads/2026-11-01/notes.md"])
                self.assertEqual(self._sources(agent_dir, tool, "assessment"),
                                 ["assessment/evidence/acme/report.md"])
                self.assertEqual(self._sources(agent_dir, tool, "nobody"), [])


class SupervisorThreadsTheTenant(unittest.TestCase):
    def test_the_verified_tenant_rides_to_the_sub_agent_signed(self):
        from agui_harness import supervisor, FakeAgentCoreRuntime

        sup = supervisor()
        runtime = FakeAgentCoreRuntime()
        sup._agentcore_runtime = runtime
        with mock.patch.dict("os.environ", {"AGENT_INVOKE_SECRET": SECRET, "INSECURE_DEV_MODE": ""}):
            token = sup._invoke_identity.set(("assessment", "u-1", "conv-1"))
            try:
                sup._invoke_sub_agent("arn:aws:bedrock-agentcore:us-east-1:1:runtime/orgiq_search", "q")
            finally:
                sup._invoke_identity.reset(token)
            sent = runtime.last_payload
            self.assertNotIn("tenant", sent)
            self.assertEqual(sent["auth"], {"tenant": "assessment", "sub": "u-1"})
            self.assertTrue(sent["authSig"].startswith("v1.orgiq-supervisor."))
            # The sub-agent's own reading of that payload.
            self.assertEqual(kb.caller_tenant(sent), "assessment")


if __name__ == "__main__":
    unittest.main()
