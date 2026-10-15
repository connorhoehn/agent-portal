#!/usr/bin/env python3
"""
Generate a realistic org dataset and apply it to Aurora via the RDS Data API.

Produces ~60 people across 6 teams with skills/projects/decisions/collaborations
plus a TRUNCATE for idempotent re-seeding. Run with no args:

  python3 schema/seed.py                # apply to live cluster
  python3 schema/seed.py --dry-run      # emit SQL to stdout only
  python3 schema/seed.py --scale 2      # double the org size

Deterministic — uses random.seed(42).
"""
from __future__ import annotations

import argparse
import os
import random
import subprocess
import sys
from dataclasses import dataclass
from typing import Iterable

random.seed(42)

# ── Schema constants (mirrors orgiq_schema.sql) ──────────────────────────────

TEAMS = [
    ("t-platform",   "Platform Engineering"),
    ("t-data",       "Data Platform"),
    ("t-product",    "Product"),
    ("t-design",     "Design Systems"),
    ("t-ml",         "ML / AI"),
    ("t-security",   "Security"),
]

SKILLS_BY_DOMAIN = {
    "infra": [
        ("Kubernetes", "infra"), ("Terraform", "infra"), ("Service Mesh", "infra"),
        ("Docker", "infra"), ("AWS", "infra"), ("CI/CD", "infra"),
        ("Observability", "infra"), ("Linux Internals", "infra"),
    ],
    "language": [
        ("Go", "language"), ("Python", "language"), ("Java", "language"),
        ("TypeScript", "language"), ("Rust", "language"),
    ],
    "data": [
        ("Spark", "data"), ("Kafka", "data"), ("dbt", "data"),
        ("Snowflake", "data"), ("Airflow", "data"), ("SQL", "data"),
        ("Data Modeling", "data"),
    ],
    "ml": [
        ("PyTorch", "ml"), ("MLOps", "ml"), ("LLMs", "ml"),
        ("RAG", "ml"), ("Embeddings", "ml"),
    ],
    "frontend": [
        ("React", "frontend"), ("Figma", "frontend"), ("Design Tokens", "frontend"),
        ("Accessibility", "frontend"), ("Storybook", "frontend"),
    ],
    "product": [
        ("Product Strategy", "product"), ("User Research", "product"),
        ("Analytics", "product"), ("Roadmapping", "product"),
    ],
    "security": [
        ("IAM", "security"), ("Penetration Testing", "security"),
        ("Zero Trust", "security"), ("AWS Security", "security"),
    ],
}

# Which skill domains are likely for each team
TEAM_SKILL_DOMAINS = {
    "t-platform":  ["infra", "language", "security"],
    "t-data":      ["data", "language", "infra"],
    "t-product":   ["product", "frontend"],
    "t-design":    ["frontend", "product"],
    "t-ml":        ["ml", "language", "data"],
    "t-security":  ["security", "infra", "language"],
}

PROJECTS = [
    ("p-auth-migration",     "Auth Migration",              "in_progress"),
    ("p-observability",      "Observability Platform",      "in_progress"),
    ("p-cost-opt",           "Cost Optimization",           "in_progress"),
    ("p-realtime-analytics", "Real-time Analytics Pipeline","in_progress"),
    ("p-data-lake",          "Data Lake Migration",         "planning"),
    ("p-feature-store",      "ML Feature Store",            "in_progress"),
    ("p-mobile-redesign",    "Mobile App Redesign",         "in_progress"),
    ("p-design-v3",          "Design System v3",            "in_progress"),
    ("p-llm-platform",       "LLM Application Platform",    "in_progress"),
    ("p-rag-search",         "RAG Knowledge Search",        "completed"),
    ("p-soc2",               "SOC2 Compliance",             "in_progress"),
    ("p-zero-trust",         "Zero Trust Network",          "planning"),
]

DECISIONS = [
    ("d-aurora",        "Adopt Aurora over Neptune",       "Picked Aurora PostgreSQL + relational graph over Neptune Analytics for cost + latency reasons.",                 "2026-03-12"),
    ("d-k8s",           "Migrate to Kubernetes from ECS",  "Standardize compute layer on EKS for portability and ecosystem.",                                                "2026-02-04"),
    ("d-nova",          "Standardize on Nova Pro",         "Use amazon.nova-pro-v1 as primary inference model across all agents.",                                           "2026-04-21"),
    ("d-legacy-auth",   "Sunset legacy auth service",      "Move every remaining service off the v1 auth gateway; the SAML shim is deleted once the last tenant has cut over to Cognito.", "2026-01-30"),
    ("d-otel",          "Adopt OpenTelemetry",             "Replace ad-hoc tracing with OTLP + AWS X-Ray for unified observability.",                                        "2026-03-25"),
    ("d-react-19",      "React 19 upgrade timeline",       "Roll out React 19 across portal + design system over Q2.",                                                       "2026-04-02"),
    ("d-iceberg",       "Snowflake to Iceberg evaluation", "Pilot Iceberg-on-S3 for the analytics lakehouse — defer go/no-go to Q3.",                                        "2026-05-01"),
    ("d-vectordb",      "Vector DB vendor selection",      "Chose pgvector inside Aurora over standalone vector DBs to keep ops surface small.",                             "2026-03-18"),
]

# Realistic name pool — keep this seed-data deterministic but varied.
FIRST_NAMES = [
    "Alex","Maria","James","Priya","David","Sarah","Tom","Lisa","Ryan","Nina",
    "Carlos","Emma","Ahmed","Yuki","Marcus","Olivia","Jordan","Rachel","Kevin","Diana",
    "Ben","Sophie","Raj","Aisha","Hiro","Amara","Liam","Zoe","Owen","Mia",
    "Felix","Camila","Noah","Ava","Daniel","Layla","Henry","Sienna","Lucas","Maya",
    "Theo","Isabel","Mateo","Nora","Eli","Ruth","Ezra","Vera","Caleb","Iris",
    "Wesley","Tara","Asher","Lena","Otto","Quinn","Hugo","Bria","Pablo","Sasha",
]
LAST_NAMES = [
    "Chen","Santos","Wright","Patel","Kim","Johnson","Nakamura","Chang","O'Brien","Kowalski",
    "Rivera","Wilson","Hassan","Tanaka","Thompson","Park","Lee","Green","Nguyen","Martinez",
    "Foster","Turner","Mehta","Williams","Singh","Okafor","Brennan","Garcia","Shah","Andersson",
    "Cole","Vasquez","Müller","Becker","DaSilva","Ahmed","Reyes","Petrov","Mancini","Dubois",
]

TITLES_IC = ["Engineer", "Senior Engineer", "Staff Engineer", "Principal Engineer"]
TITLES_DESIGN = ["Designer", "Senior Designer", "Staff Designer", "Design Engineer"]
TITLES_PRODUCT = ["Product Manager", "Senior PM", "Group PM", "Director of Product"]
TITLES_MGR = ["Engineering Manager", "Senior Manager", "Director"]

TITLES_BY_TEAM = {
    "t-platform": TITLES_IC + ["SRE", "Senior SRE", "SRE Lead", "Engineering Manager"],
    "t-data":     TITLES_IC + ["Data Engineer", "Senior Data Engineer", "Staff Data Engineer", "Data Analyst", "Engineering Manager"],
    "t-product":  TITLES_PRODUCT + ["UX Researcher", "Senior UX Researcher", "Technical Writer"],
    "t-design":   TITLES_DESIGN + ["Head of Design", "UX Engineer", "Accessibility Specialist"],
    "t-ml":       TITLES_IC + ["ML Engineer", "Senior ML Engineer", "Staff ML Engineer", "Engineering Manager"],
    "t-security": TITLES_IC + ["Security Engineer", "Senior Security Engineer", "Security Lead"],
}

PEOPLE_PER_TEAM_BASE = {  # before --scale multiplier
    "t-platform":  14,
    "t-data":      11,
    "t-product":   8,
    "t-design":    7,
    "t-ml":        10,
    "t-security":  6,
}

# One cast (docs/demo-content-goal.md rule 5): no two people a peer meets in
# one story share a first name, and none shares one with the sign-in cast
# (middleware/src/providers/identity.ts). The random draw above produced three
# Noras, four Hugos and namesakes of Vera, Theo, Mia, Caleb, Rachel and Lena;
# these overrides rename them AFTER the draw, so every other generated value
# (skills, collaborations, scores) is unchanged. A title override names what
# the person does in the story (the release manager is not an "Engineer").
NAME_OVERRIDES: dict[str, tuple[str, str | None]] = {
    "p-003": ("Owen Brooks", None),  # was Marcus O'Brien
    "p-009": ("Arjun Shah", None),  # was Marcus Shah
    "p-010": ("Kenji Chen", None),  # was Tara Chen
    "p-014": ("Grace Singh", None),  # was Sarah Singh
    "p-018": ("Yusuf Ahmed", None),  # was Sarah Ahmed
    "p-019": ("Camille Dubois", None),  # was Lena Dubois
    "p-024": ("Andre Williams", None),  # was Theo Williams
    "p-025": ("Anika Mehta", None),  # was Aisha Mehta
    "p-028": ("Felix Rivera", None),  # was Theo Rivera
    "p-031": ("Fatima Ahmed", None),  # was Sasha Ahmed
    "p-032": ("Ruth Foster", None),  # was Nora Foster
    "p-034": ("Miles Wright", None),  # was Asher Wright
    "p-037": ("Oscar Foster", None),  # was Hugo Foster
    "p-039": ("Nils Andersson", None),  # was Hugo Andersson
    "p-041": ("Rosa Ahmed", None),  # was Vera Ahmed
    "p-042": ("Katya Petrov", None),  # was Vera Petrov
    "p-044": ("Zoe Thompson", None),  # was Aisha Thompson
    "p-046": ("Vikram Patel", None),  # was Caleb Patel
    "p-049": ("Paolo Mancini", None),  # was Hiro Mancini
    "p-051": ("Simone Chang", None),  # was Nora Chang
    "p-052": ("Diego Ortiz", None),  # was Hugo DaSilva
    "p-053": ("Ingrid Larsen", None),  # was Rachel Turner
    "p-055": ("Joy Chen", None),  # was Mia Chen
    "p-005": ("Sienna Garcia", "Release Manager"),
}


@dataclass
class Person:
    id: str
    name: str
    email: str
    title: str
    team_id: str


def gen_people(scale: float) -> list[Person]:
    used_names: set[str] = set()
    people: list[Person] = []
    pid = 1
    for team_id, count_base in PEOPLE_PER_TEAM_BASE.items():
        count = max(2, int(count_base * scale))
        for _ in range(count):
            for _attempt in range(20):
                first = random.choice(FIRST_NAMES)
                last = random.choice(LAST_NAMES)
                name = f"{first} {last}"
                if name not in used_names:
                    used_names.add(name)
                    break
            title = random.choice(TITLES_BY_TEAM[team_id])
            email = f"{first.lower()}.{last.lower().replace(chr(39), '')}@orgiq.example"
            people.append(Person(
                id=f"p-{pid:03d}",
                name=name,
                email=email,
                title=title,
                team_id=team_id,
            ))
            pid += 1
    for person in people:
        override = NAME_OVERRIDES.get(person.id)
        if override:
            name, title = override
            first, last = name.split(" ", 1)
            person.name = name
            person.email = f"{first.lower()}.{last.lower().replace(chr(39), '')}@orgiq.example"
            if title:
                person.title = title
    return people


def gen_person_skills(people: list[Person]) -> list[tuple[str, str, float]]:
    """Assign 3-5 skills per person, weighted toward team's typical domains."""
    out = []
    all_skills_flat = [(name_dom[0], dom) for dom, ss in SKILLS_BY_DOMAIN.items() for name_dom in ss]
    skill_id_by_name = {name: f"sk-{name.lower().replace(' ', '-').replace('/', '-')}" for name, _ in all_skills_flat}
    for person in people:
        domains = TEAM_SKILL_DOMAINS[person.team_id]
        # Heavily-weighted pool: 70% from team's domains, 30% from anywhere
        team_pool = [s for s in all_skills_flat if s[1] in domains]
        chosen: set[str] = set()
        for _ in range(random.randint(3, 6)):
            if random.random() < 0.7:
                skill_name = random.choice(team_pool)[0]
            else:
                skill_name = random.choice(all_skills_flat)[0]
            chosen.add(skill_name)
        for skill_name in chosen:
            weight = round(random.uniform(0.5, 1.0), 2)
            out.append((person.id, skill_id_by_name[skill_name], weight))
    return out


def gen_collaborations(people: list[Person]) -> list[tuple[str, str, float]]:
    """Person-person collaborations — dense intra-team, sparse cross-team."""
    by_team: dict[str, list[Person]] = {}
    for p in people:
        by_team.setdefault(p.team_id, []).append(p)

    edges: set[tuple[str, str]] = set()

    # Intra-team: each person collabs with ~70% of their team
    for team_id, members in by_team.items():
        for i, a in enumerate(members):
            for b in members[i + 1:]:
                if random.random() < 0.7:
                    edges.add(tuple(sorted([a.id, b.id])))

    # Cross-team bridges: ~15% of all cross-team pairs
    for i, a in enumerate(people):
        for b in people[i + 1:]:
            if a.team_id != b.team_id and random.random() < 0.04:
                edges.add(tuple(sorted([a.id, b.id])))

    return [(a, b, round(random.uniform(0.3, 1.0), 2)) for a, b in edges]


def gen_project_contributions(people: list[Person]) -> list[tuple[str, str, str, float]]:
    """Each person works on 1-3 projects. Affinity by team."""
    project_team_affinity = {
        "p-auth-migration":     ["t-platform", "t-security"],
        "p-observability":      ["t-platform"],
        "p-cost-opt":           ["t-platform", "t-data"],
        "p-realtime-analytics": ["t-data"],
        "p-data-lake":          ["t-data"],
        "p-feature-store":      ["t-data", "t-ml"],
        "p-mobile-redesign":    ["t-product", "t-design"],
        "p-design-v3":          ["t-design"],
        "p-llm-platform":       ["t-ml", "t-platform"],
        "p-rag-search":         ["t-ml", "t-data"],
        "p-soc2":               ["t-security"],
        "p-zero-trust":         ["t-security", "t-platform"],
    }
    out = []
    for p in people:
        affinity_projects = [pid for pid, teams in project_team_affinity.items() if p.team_id in teams]
        n = random.randint(1, 3)
        chosen = set()
        # Prefer affinity
        for _ in range(n):
            if affinity_projects and random.random() < 0.8:
                chosen.add(random.choice(affinity_projects))
            else:
                chosen.add(random.choice([proj[0] for proj in PROJECTS]))
        for proj_id in chosen:
            role = random.choice(["contributor", "lead", "reviewer"])
            weight = round(random.uniform(0.4, 1.0), 2)
            out.append((p.id, proj_id, role, weight))
    return out


def gen_decision_participants(people: list[Person]) -> list[tuple[str, str, str]]:
    """Some people participate in some decisions."""
    out = []
    for d_id, _topic, _summary, _date in DECISIONS:
        # 4-12 participants per decision
        n = random.randint(4, 12)
        participants = random.sample(people, n)
        for i, p in enumerate(participants):
            role = "decider" if i == 0 else "contributor"
            out.append((p.id, d_id, role))
    return out


def compute_pagerank(people: list[Person], collabs: list[tuple[str, str, float]],
                     contribs: list[tuple[str, str, str, float]],
                     decisions: list[tuple[str, str, str]]) -> dict[str, float]:
    """Simple iterative PageRank on a graph treating all edges as undirected with weights."""
    n = len(people)
    if n == 0:
        return {}
    # Build adjacency
    adj: dict[str, list[tuple[str, float]]] = {p.id: [] for p in people}
    for a, b, w in collabs:
        adj[a].append((b, w))
        adj[b].append((a, w))
    # Project + decision co-participation as additional edges (lighter weight)
    for table, cols in [(contribs, (0, 1)), (decisions, (0, 1))]:
        by_group: dict[str, list[str]] = {}
        for row in table:
            person, group = row[cols[0]], row[cols[1]]
            by_group.setdefault(group, []).append(person)
        for members in by_group.values():
            for i, a in enumerate(members):
                for b in members[i + 1:]:
                    adj[a].append((b, 0.3))
                    adj[b].append((a, 0.3))

    scores = {p.id: 1.0 / n for p in people}
    damping = 0.85
    for _ in range(30):
        new_scores = {}
        for p in people:
            in_flow = 0.0
            for neighbor, w in adj[p.id]:
                deg = sum(w2 for _, w2 in adj[neighbor]) or 1.0
                in_flow += scores[neighbor] * w / deg
            new_scores[p.id] = (1 - damping) / n + damping * in_flow
        scores = new_scores
    # Normalize to 0-100
    mx = max(scores.values()) or 1.0
    return {pid: round((s / mx) * 100, 2) for pid, s in scores.items()}


def compute_expertise(people: list[Person], person_skills: list[tuple[str, str, float]]) -> dict[str, float]:
    """Expertise = sum of skill weights, normalized 0-100."""
    sums: dict[str, float] = {p.id: 0.0 for p in people}
    for pid, _sk, w in person_skills:
        sums[pid] += w
    mx = max(sums.values()) or 1.0
    return {pid: round((v / mx) * 100, 2) for pid, v in sums.items()}


# ── SQL emission ──────────────────────────────────────────────────────────────

def sqlstr(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def emit_statements(scale: float) -> list[str]:
    people = gen_people(scale)
    person_skills = gen_person_skills(people)
    collabs = gen_collaborations(people)
    contribs = gen_project_contributions(people)
    decisions = gen_decision_participants(people)

    pagerank = compute_pagerank(people, collabs, contribs, decisions)
    expertise = compute_expertise(people, person_skills)
    composite = {p.id: round(0.55 * pagerank[p.id] + 0.45 * expertise[p.id], 2) for p in people}

    stmts: list[str] = []

    # Wipe in dependency order
    for tbl in [
        "node_embeddings", "mentions", "decision_participants",
        "project_contributions", "collaborations", "team_memberships",
        "person_skills", "documents", "decisions", "projects",
        "people", "teams", "skills",
    ]:
        stmts.append(f"DELETE FROM {tbl}")

    # Teams
    for tid, name in TEAMS:
        stmts.append(f"INSERT INTO teams (id, name) VALUES ({sqlstr(tid)}, {sqlstr(name)})")

    # Skills
    for domain, items in SKILLS_BY_DOMAIN.items():
        for name, dom in items:
            sk_id = f"sk-{name.lower().replace(' ', '-').replace('/', '-')}"
            stmts.append(
                f"INSERT INTO skills (id, name, domain) VALUES ({sqlstr(sk_id)}, {sqlstr(name)}, {sqlstr(dom)})"
            )

    # Projects
    for pid, name, status in PROJECTS:
        stmts.append(
            f"INSERT INTO projects (id, name, status) VALUES ({sqlstr(pid)}, {sqlstr(name)}, {sqlstr(status)})"
        )

    # Decisions
    for d_id, topic, summary, decided_at in DECISIONS:
        stmts.append(
            "INSERT INTO decisions (id, topic, summary, decided_at) VALUES ("
            f"{sqlstr(d_id)}, {sqlstr(topic)}, {sqlstr(summary)}, DATE {sqlstr(decided_at)})"
        )

    # People with computed scores
    for p in people:
        stmts.append(
            "INSERT INTO people (id, name, email, title, team, expertise_score, pagerank_score, composite_score, scored_at) "
            f"VALUES ({sqlstr(p.id)}, {sqlstr(p.name)}, {sqlstr(p.email)}, {sqlstr(p.title)}, "
            f"{sqlstr(next(t[1] for t in TEAMS if t[0] == p.team_id))}, "
            f"{expertise[p.id]}, {pagerank[p.id]}, {composite[p.id]}, NOW())"
        )

    # Team memberships
    for p in people:
        stmts.append(
            f"INSERT INTO team_memberships (person_id, team_id, role) VALUES ({sqlstr(p.id)}, {sqlstr(p.team_id)}, {sqlstr(p.title)})"
        )

    # Person-skills
    for pid, sk_id, w in person_skills:
        stmts.append(
            f"INSERT INTO person_skills (person_id, skill_id, weight, source) VALUES ({sqlstr(pid)}, {sqlstr(sk_id)}, {w}, 'seed')"
        )

    # Collaborations (canonical ordering already enforced)
    for a, b, w in collabs:
        stmts.append(
            f"INSERT INTO collaborations (person_a_id, person_b_id, weight) VALUES ({sqlstr(a)}, {sqlstr(b)}, {w})"
        )

    # Project contributions
    for pid, proj_id, role, w in contribs:
        stmts.append(
            f"INSERT INTO project_contributions (person_id, project_id, role, weight) VALUES ({sqlstr(pid)}, {sqlstr(proj_id)}, {sqlstr(role)}, {w})"
        )

    # Decision participants
    for pid, d_id, role in decisions:
        stmts.append(
            f"INSERT INTO decision_participants (person_id, decision_id, role) VALUES ({sqlstr(pid)}, {sqlstr(d_id)}, {sqlstr(role)})"
        )

    return stmts


# ── Apply ─────────────────────────────────────────────────────────────────────

def get_cluster_arns() -> tuple[str, str]:
    region = os.environ.get("AWS_REGION", "us-east-1")
    def cf(key: str) -> str:
        return subprocess.check_output([
            "aws", "cloudformation", "describe-stacks",
            "--stack-name", "OrgIQ-Aurora", "--region", region,
            "--query", f"Stacks[0].Outputs[?OutputKey=='{key}'].OutputValue",
            "--output", "text",
        ], text=True).strip()
    return cf("ClusterArn"), cf("CredentialsSecretArn")


def apply(stmts: list[str]) -> None:
    import time
    cluster_arn, secret_arn = get_cluster_arns()
    region = os.environ.get("AWS_REGION", "us-east-1")
    import boto3
    rds = boto3.client("rds-data", region_name=region)
    for i, stmt in enumerate(stmts):
        # A freshly-created Aurora cluster intermittently reports its Data API
        # endpoint as not-yet-enabled for the first few minutes, even after it
        # reports available. That is transient, so retry the statement rather
        # than aborting the whole seed on one flake.
        last_err = None
        for attempt in range(8):
            try:
                rds.execute_statement(
                    resourceArn=cluster_arn,
                    secretArn=secret_arn,
                    database="orgiq",
                    sql=stmt,
                )
                last_err = None
                break
            except rds.exceptions.HttpEndpointNotEnabledException as e:
                last_err = e
                time.sleep(5)
            except Exception as e:
                print(f"  ✗ stmt {i + 1}/{len(stmts)} failed: {stmt[:120]}", file=sys.stderr)
                print(f"    {e}", file=sys.stderr)
                raise
        if last_err is not None:
            print(f"  ✗ stmt {i + 1}/{len(stmts)} still failing after retries: {stmt[:120]}", file=sys.stderr)
            raise last_err
        if (i + 1) % 50 == 0:
            print(f"  applied {i + 1}/{len(stmts)} statements...")
    print(f"  applied {len(stmts)} statements.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scale", type=float, default=1.0, help="Multiplier for headcount (default 1.0)")
    parser.add_argument("--dry-run", action="store_true", help="Emit SQL to stdout, don't apply")
    parser.add_argument("--output", help="Also write SQL to this file")
    args = parser.parse_args()

    stmts = emit_statements(args.scale)
    print(f"Generated {len(stmts)} statements", file=sys.stderr)

    if args.output:
        with open(args.output, "w") as f:
            for s in stmts:
                f.write(s + ";\n")
        print(f"Wrote {args.output}", file=sys.stderr)

    if args.dry_run:
        for s in stmts:
            print(s + ";")
        return

    apply(stmts)
    print("Seed applied.")


if __name__ == "__main__":
    main()
