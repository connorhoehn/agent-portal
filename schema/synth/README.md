# synth — OrgIQ synthetic corpus pipeline

Generates ~163 demo-grade documents (ADRs, postmortems, perf reviews, Slack
threads, all-hands recaps) from the seed graph in Aurora. Outputs land in
S3 + the Bedrock Knowledge Base and the `documents` / `mentions` tables.

## Setup

```bash
cd /Users/connorhoehn/Projects/aws-agentcore
python3.11 -m venv .venv-synth
.venv-synth/bin/pip install -r schema/synth/requirements.txt
```

## Run

Run from the repo root so `schema.synth` resolves as a package.

```bash
# Smoke test: verifies Aurora connectivity + seed graph
.venv-synth/bin/python -m schema.synth check

# (Wired in subsequent steps)
# python -m schema.synth personas
# python -m schema.synth docs
# python -m schema.synth load
# python -m schema.synth all

# Portrait avatars (Nova Canvas, ~$2 for the cast; NOT part of `all`)
.venv-synth/bin/python -m schema.synth avatars --skip-load        # PNGs only
.venv-synth/bin/python -m schema.synth avatars [--snapshot f.json] [--only p-001,p-002]
```

Cache lives in `schema/synth/cache/` (gitignored). Delete it to force regen.

## Models

AWS-native only:
- `amazon.nova-pro-v1:0` — ADRs, postmortems, perf reviews
- `amazon.nova-lite-v1:0` — Slack threads, all-hands recaps
- `amazon.titan-embed-text-v2:0` @ 1024d — node_embeddings
- `amazon.nova-canvas-v1:0` — person avatars (`avatars` subcommand)

## Cost (demo-grade)

~$0.45 per full regen, free on cache hits.

Avatars: ~$0.04/image (standard quality), so ~$2.24 for the 56-person cast,
free on cache hits (`cache/avatars/<id>.png` + a `.json` key sidecar).

## Avatars

`avatars` builds a prompt from role (`people.title`) and department (team
name) plus seed-derived traits; the person's name is never sent. Images are
320x320: Nova Canvas rejects sides under 320, and Pillow is not in
`.venv-synth`, so there is no 256 downscale.

Serving: the artifacts bucket is private, so `load` uploads to
`s3://orgiq-artifacts-<acct>-<region>/avatars/<id>.png` as an archive, copies
the PNG to `portal/public/avatars/` (served by the portal bundle), and sets
`people.avatar_url = '/avatars/<id>.png'` (override the base with
`SYNTH_AVATAR_URL_BASE`). The columns `people.avatar_url` and
`app_users.avatar_url` are added in `schema/orgiq_schema.sql` and
`schema/identity_schema.sql`; apply those before loading.
