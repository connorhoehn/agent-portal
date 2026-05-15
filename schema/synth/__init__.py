"""OrgIQ synthetic corpus pipeline.

Generates personas, internal docs (ADRs, postmortems, perf reviews, Slack threads,
all-hands recaps), and news articles for the OrgIQ demo. Reads the seed graph
from Aurora (populated by schema/seed.py), writes documents to S3 + the Bedrock
Knowledge Base, and upserts the `documents` / `mentions` / newsroom tables.

Run with:
    python -m schema.synth all          # full pipeline
    python -m schema.synth personas     # personas only
    python -m schema.synth docs         # internal docs only
    python -m schema.synth news         # news articles only
    python -m schema.synth ner          # extract entities from articles
    python -m schema.synth cluster      # cluster articles → story_clusters
    python -m schema.synth load         # upsert + KB sync
"""
