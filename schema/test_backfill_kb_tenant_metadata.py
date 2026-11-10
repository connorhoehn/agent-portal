"""The tenant-metadata backfill plans one sidecar per document that lacks one."""
import json
import unittest

import backfill_kb_tenant_metadata as b


class Plan(unittest.TestCase):
    PREFIXES = [("orgiq/", "orgiq"), ("assessment/", "assessment"), ("orgiq/hr/", "hr-kb-tenant")]

    def test_one_sidecar_per_document_without_one_owner_by_longest_prefix(self):
        keys = ["orgiq/a.md", "orgiq/a.md.metadata.json", "orgiq/b.md", "orgiq/hr/c.md",
                "assessment/e/d.pdf", "elsewhere/x.md", "orgiq/folder/"]
        self.assertEqual(b.plan(keys, self.PREFIXES), [
            ("orgiq/b.md.metadata.json", "orgiq"),
            ("orgiq/hr/c.md.metadata.json", "hr-kb-tenant"),
            ("assessment/e/d.pdf.metadata.json", "assessment"),
        ])

    def test_the_body_is_bedrock_metadata(self):
        self.assertEqual(json.loads(b.sidecar_body("assessment")), {"metadataAttributes": {"tenant": "assessment"}})

    def test_the_declared_prefixes_come_from_the_shared_file(self):
        self.assertIn(("synth/", "orgiq"), b.declared_prefixes())


if __name__ == "__main__":
    unittest.main()
