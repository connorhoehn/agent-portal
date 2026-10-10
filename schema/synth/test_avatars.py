import base64, io, json, tempfile, unittest
from pathlib import Path
from unittest import mock

from . import avatars

PNG = base64.b64encode(
    base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
).decode()


class FakeBedrock:
    def __init__(self, payload=None):
        self.calls = []
        self.payload = payload or {"images": [PNG]}

    def invoke_model(self, **kw):
        self.calls.append(kw)
        return {"body": io.BytesIO(json.dumps(self.payload).encode())}


class FakeS3:
    def __init__(self):
        self.puts = []

    def put_object(self, **kw):
        self.puts.append(kw)


def person(i=1, **kw):
    return {"id": f"p-{i:03d}", "name": f"Zed Quux{i}", "title": "Staff Engineer",
            "department": "Platform", **kw}


class AvatarTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        for name, sub in (("AVATAR_DIR", "cache"), ("PORTAL_AVATAR_DIR", "portal")):
            pt = mock.patch.object(avatars, name, self.tmp / sub)
            pt.start()
            self.addCleanup(pt.stop)
        pe = mock.patch.dict("os.environ", {"AWS_ACCOUNT_ID": "123456789012"})
        pe.start()
        self.addCleanup(pe.stop)

    def test_prompt_and_body_shape(self):
        p = person()
        b = avatars.request_body(p)
        self.assertEqual(b["taskType"], "TEXT_IMAGE")
        cfg = b["imageGenerationConfig"]
        self.assertEqual((cfg["width"], cfg["height"]), (320, 320))
        self.assertEqual(cfg["seed"], avatars.style_seed("p-001"))
        self.assertEqual(b, avatars.request_body(p))
        text = b["textToImageParams"]["text"]
        self.assertNotIn("Zed", text)
        self.assertNotIn("Quux", text)
        self.assertIn("Staff Engineer", text)
        self.assertIn("Platform", text)
        self.assertLess(len(text), 1024)
        self.assertIn("photographic", text)
        self.assertIn("cartoon", b["textToImageParams"]["negativeText"])
        self.assertNotIn("photorealistic", b["textToImageParams"]["negativeText"])

    def test_seeds_and_traits_vary(self):
        seeds = {avatars.style_seed(f"p-{i:03d}") for i in range(1, 57)}
        self.assertEqual(len(seeds), 56)
        combos = {tuple(avatars.traits(f"p-{i:03d}").values()) for i in range(1, 57)}
        self.assertGreater(len(combos), 40)
        self.assertEqual(avatars.style_seed("p-001"), avatars.style_seed("p-001"))

    def test_with_departments(self):
        out = avatars.with_departments([{"id": "p-1", "title": "x", "team_id": "t1"}],
                                       [{"id": "t1", "name": "Data"}])
        self.assertEqual(out[0]["department"], "Data")

    def test_cache_hit_and_invalidation(self):
        c = FakeBedrock()
        p = person()
        avatars.generate_one(p, client=c)
        avatars.generate_one(p, client=c)
        self.assertEqual(len(c.calls), 1)
        self.assertEqual(c.calls[0]["modelId"], "amazon.nova-canvas-v1:0")
        avatars.generate_one({**p, "title": "Designer"}, client=c)
        self.assertEqual(len(c.calls), 2)

    def test_error_payload_raises(self):
        with self.assertRaises(RuntimeError):
            avatars.generate_one(person(), client=FakeBedrock({"error": "blocked"}))
        self.assertFalse((avatars.AVATAR_DIR / "p-001.png").exists())

    def test_upsert_idempotent_sql_and_missing_skipped(self):
        people = [person(1), person(2)]
        avatars.generate_one(people[0], client=FakeBedrock())
        s3, sql = FakeS3(), []
        n = avatars.upload_and_upsert(people, s3=s3, execute=lambda q, params=None: sql.append((q, params)))
        self.assertEqual(n, 1)
        self.assertEqual(len(s3.puts), 1)
        self.assertEqual(s3.puts[0]["Bucket"], "orgiq-artifacts-123456789012-" + avatars.CONFIG.region)
        self.assertEqual(s3.puts[0]["Key"], "avatars/p-001.png")
        self.assertEqual(len(sql), 1)
        self.assertIn("IS DISTINCT FROM", sql[0][0])
        self.assertEqual(sql[0][1], [
            {"name": "id", "value": {"stringValue": "p-001"}},
            {"name": "url", "value": {"stringValue": "/avatars/p-001.png"}}])
        self.assertTrue((avatars.PORTAL_AVATAR_DIR / "p-001.png").exists())

    def test_skip_load_makes_no_s3_or_sql_calls(self):
        s3, sql = FakeS3(), []
        with mock.patch.object(avatars, "upload_and_upsert") as up:
            avatars.run([person()], skip_load=True, client=FakeBedrock(), s3=s3,
                        execute=lambda *a, **k: sql.append(1))
            up.assert_not_called()
        self.assertEqual((s3.puts, sql), ([], []))

    def test_url_base_override(self):
        with mock.patch.dict("os.environ", {"SYNTH_AVATAR_URL_BASE": "https://cdn.x/a/"}):
            self.assertEqual(avatars.avatar_url("p-9"), "https://cdn.x/a/p-9.png")


if __name__ == "__main__":
    unittest.main()
