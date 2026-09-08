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
```

Cache lives in `schema/synth/cache/` (gitignored). Delete it to force regen.

## Models

AWS-native only:
- `amazon.nova-pro-v1:0` — ADRs, postmortems, perf reviews
- `amazon.nova-lite-v1:0` — Slack threads, all-hands recaps
- `amazon.titan-embed-text-v2:0` @ 1024d — node_embeddings

## Cost (demo-grade)

~$0.45 per full regen, free on cache hits.
