#!/usr/bin/env python3
"""Seed additional supervisor test cases that explicitly require A2A routing.

These prompts force the supervisor to invoke MULTIPLE sub-agents, so the
trace tree on the InvocationDetail page populates richly. Designed to
exercise the supervisor → {search, scoring, advisor, ingestion} fan-out
patterns that aren't exercised by the 2 starter supervisor cases.

Idempotent — UPSERT by test_id.
"""
import json
import subprocess

REGION = "us-east-1"
DATABASE = "orgiq"

def cf_output(stack, key):
    r = subprocess.run(
        ["aws", "cloudformation", "describe-stacks",
         "--stack-name", stack, "--region", REGION,
         "--query", f"Stacks[0].Outputs[?OutputKey=='{key}'].OutputValue",
         "--output", "text"],
        capture_output=True, text=True, check=True,
    )
    return r.stdout.strip()

CLUSTER_ARN = cf_output("OrgIQ-Aurora", "ClusterArn")
SECRET_ARN  = cf_output("OrgIQ-Aurora", "CredentialsSecretArn")

def exec_sql(sql, params=None):
    args = ["aws", "rds-data", "execute-statement",
            "--resource-arn", CLUSTER_ARN,
            "--secret-arn", SECRET_ARN,
            "--database", DATABASE,
            "--region", REGION,
            "--sql", sql, "--output", "json"]
    if params:
        args += ["--parameters", json.dumps(params)]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    return r.stdout

# Each prompt is designed to FORCE A2A. The supervisor can't answer any of
# them inline — it must invoke specialists. That's the property we want for
# trace-tree validation: every successful run produces parent-linked rows.
CASES = [
    {
        "test_id": "supervisor.fan-out.experts-plus-scores.001",
        "agent_id": "orgiq-supervisor",
        "template_id": "test:supervisor",
        "prompt": (
            "Find me the top 3 Kubernetes experts at the company AND compute their "
            "current expertise scores AND tell me which projects they collaborated on."
        ),
        "expected_tags": ["names-search-agent", "names-scoring-agent", "lists-people"],
        "pass_threshold": 0.65,
        "notes": "Forces supervisor → search + scoring + advisor fan-out."
    },
    {
        "test_id": "supervisor.fan-out.ingest-then-advise.002",
        "agent_id": "orgiq-supervisor",
        "template_id": "test:supervisor",
        "prompt": (
            "Ingest the latest transaction batch from S3 and then advise me on which "
            "anomalies need leadership attention this week."
        ),
        "expected_tags": ["names-ingestion-agent", "actionable", "prioritized"],
        "pass_threshold": 0.65,
        "notes": "Forces supervisor → ingestion + advisor sequential chain."
    },
    {
        "test_id": "supervisor.compound.expert-with-context.003",
        "agent_id": "orgiq-supervisor",
        "template_id": "test:supervisor",
        "prompt": (
            "Who is our best Python expert, what is their score, and what advice "
            "would you give to a Python team lead looking to onboard them onto a "
            "new ML platform project?"
        ),
        "expected_tags": ["names-search-agent", "names-scoring-agent", "actionable"],
        "pass_threshold": 0.7,
        "notes": "Three-way fan-out: search + scoring + advisor."
    },
    {
        "test_id": "supervisor.compound.skill-gap-analysis.004",
        "agent_id": "orgiq-supervisor",
        "template_id": "test:supervisor",
        "prompt": (
            "Identify the top 3 skill gaps on the platform team and recommend "
            "specific mentors from elsewhere in the company who could help close them."
        ),
        "expected_tags": ["lists-people", "actionable", "names-search-agent"],
        "pass_threshold": 0.65,
        "notes": "Forces supervisor → advisor + search (for mentor matching)."
    },
    {
        "test_id": "supervisor.compound.incident-response.005",
        "agent_id": "orgiq-supervisor",
        "template_id": "test:supervisor",
        "prompt": (
            "We have a production incident in the data ingestion pipeline. "
            "Who should I page right now (with scores), and what's their typical "
            "response time based on prior incidents?"
        ),
        "expected_tags": ["lists-people", "actionable", "prioritized", "names-search-agent"],
        "pass_threshold": 0.7,
        "notes": "Forces supervisor → search + scoring + advisor for incident workflow."
    },
]

UPSERT_SQL = """
    INSERT INTO observability.test_cases (
        test_id, agent_id, template_id, prompt, reference_output,
        expected_tags, pass_threshold, active, notes
    ) VALUES (
        :test_id, :agent_id, :template_id, :prompt, :reference_output,
        :expected_tags::jsonb, :pass_threshold, true, :notes
    )
    ON CONFLICT (test_id) DO UPDATE SET
        agent_id = EXCLUDED.agent_id,
        template_id = EXCLUDED.template_id,
        prompt = EXCLUDED.prompt,
        reference_output = EXCLUDED.reference_output,
        expected_tags = EXCLUDED.expected_tags,
        pass_threshold = EXCLUDED.pass_threshold,
        notes = EXCLUDED.notes,
        updated_at = now()
"""

for c in CASES:
    params = [
        {"name": "test_id",         "value": {"stringValue": c["test_id"]}},
        {"name": "agent_id",        "value": {"stringValue": c["agent_id"]}},
        {"name": "template_id",     "value": {"stringValue": c["template_id"]}},
        {"name": "prompt",          "value": {"stringValue": c["prompt"]}},
        {"name": "reference_output",
         "value": ({"stringValue": c["reference_output"]} if c.get("reference_output")
                   else {"isNull": True})},
        {"name": "expected_tags",   "value": {"stringValue": json.dumps(c.get("expected_tags", []))}},
        {"name": "pass_threshold",  "value": {"doubleValue": float(c["pass_threshold"])}},
        {"name": "notes",           "value": {"stringValue": c.get("notes", "")}},
    ]
    exec_sql(UPSERT_SQL, params)
    print(f"upserted {c['test_id']}")

print(f"\nseeded {len(CASES)} A2A-forcing supervisor test cases")
