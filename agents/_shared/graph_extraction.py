"""What graph-builder may write from a model's extraction, and for whom.

graph-builder asks a model to read an untrusted document and answer a JSON
object of people, skills, teams, projects and relationships, then upserts each
one into the org graph. Before this check every element the model answered was
written as given: any id, any label pairing, entities the document never names,
and for any caller that reached the agent. Everything the model answers is now
checked here before a single write, and what fails is dropped and counted.

Two gates:

*   **The caller.** The graph tables belong to the ``orgiq`` tenant. Writes run
    only for a verified caller (``invoke_auth.verified_auth``) whose tenant is
    ``orgiq``, or who holds the cross-tenant ``admin`` role (the middleware's
    agent route lets the same two through). No verified caller, another tenant:
    nothing is written, and every element is counted as dropped for ``tenant``.
*   **The shape.** Each entity is an object with a usable id and a name (bounded
    lengths), of one of the four kinds the extraction asks for, and its name
    must appear in the document (case and spacing ignored). Optional text fields
    (email, team, role, domain, status) are kept only when they appear in the
    document too, otherwise blanked. A relationship needs one of the types the
    graph stores for these kinds, with the label pair that type means, and both
    endpoints among the entities accepted from the same document. Each kind has
    a count bound; the rest are dropped for ``limit``.

Stdlib only, so it is tested without the agent SDKs.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

#: The tenant whose graph tables graph-builder writes.
GRAPH_TENANT = "orgiq"
#: The role the middleware lets through every tenant guard.
CROSS_TENANT_ROLE = "admin"

#: Extraction key -> node label.
ENTITY_KINDS = {
    "people": "Person",
    "skills": "Skill",
    "teams": "Team",
    "projects": "Project",
}
#: Optional text fields per kind, kept only when the document contains them.
OPTIONAL_FIELDS = {
    "people": ("email", "team", "role"),
    "skills": ("domain",),
    "teams": (),
    "projects": ("status",),
}
#: Relationship type -> (from label, to label). MADE and PARTICIPATED_IN need a
#: Decision endpoint, which an extraction never produces, so they are not here.
RELATIONSHIP_KINDS = {
    "HAS_SKILL": ("Person", "Skill"),
    "MEMBER_OF": ("Person", "Team"),
    "WORKED_ON": ("Person", "Project"),
    "WORKED_WITH": ("Person", "Person"),
}

MAX_ID_LEN = 120
MAX_NAME_LEN = 200
MAX_FIELD_LEN = 200
MAX_PER_KIND = 200
MAX_RELATIONSHIPS = 500


def safe_id(value: str) -> str:
    """The slug graph-builder stores (main._safe_id)."""
    return re.sub(r"[^a-z0-9_]", "_", value.lower().strip())


def caller_may_write(auth) -> bool:
    """True when the verified caller may write the graph tables."""
    if not isinstance(auth, dict):
        return False
    tenant = auth.get("tenant")
    role = auth.get("role")
    return tenant == GRAPH_TENANT or role == CROSS_TENANT_ROLE


def _normalise(text: str) -> str:
    folded = unicodedata.normalize("NFKC", text).casefold()
    return " ".join(folded.split())


@dataclass
class Checked:
    """The extraction that may be written, and what was dropped and why."""

    entities: dict = field(default_factory=lambda: {k: [] for k in ENTITY_KINDS})
    relationships: list = field(default_factory=list)
    #: reason -> count of dropped elements.
    dropped: dict = field(default_factory=dict)
    #: Optional fields blanked because the document does not contain them.
    fields_cleared: int = 0

    def drop(self, reason: str, n: int = 1) -> None:
        if n > 0:
            self.dropped[reason] = self.dropped.get(reason, 0) + n

    @property
    def dropped_total(self) -> int:
        return sum(self.dropped.values())


def _count_all(extracted) -> int:
    if not isinstance(extracted, dict):
        return 0
    total = 0
    for key in (*ENTITY_KINDS, "relationships"):
        items = extracted.get(key)
        if isinstance(items, list):
            total += len(items)
    return total


def check_extraction(extracted, document_text: str, auth) -> Checked:
    """Validate ``extracted`` (the model's parsed JSON) against the schema, the
    document it came from and the verified caller ``auth``."""
    out = Checked()
    if not caller_may_write(auth):
        out.drop("tenant", _count_all(extracted))
        return out
    if not isinstance(extracted, dict):
        out.drop("schema")
        return out

    source = _normalise(document_text or "")
    accepted: dict[str, set[str]] = {label: set() for label in ENTITY_KINDS.values()}

    for key, label in ENTITY_KINDS.items():
        items = extracted.get(key)
        if items is None:
            continue
        if not isinstance(items, list):
            out.drop("schema")
            continue
        for index, item in enumerate(items):
            if index >= MAX_PER_KIND:
                out.drop("limit", len(items) - MAX_PER_KIND)
                break
            if not isinstance(item, dict):
                out.drop("schema")
                continue
            name = item.get("name")
            raw_id = item.get("id") or name
            if not isinstance(name, str) or not isinstance(raw_id, str):
                out.drop("schema")
                continue
            name = name.strip()
            slug = safe_id(raw_id)
            if not name or len(name) > MAX_NAME_LEN or not slug.strip("_") or len(slug) > MAX_ID_LEN:
                out.drop("schema")
                continue
            if _normalise(name) not in source:
                out.drop("not_in_source")
                continue
            clean = {"id": slug, "name": name}
            for opt in OPTIONAL_FIELDS[key]:
                value = item.get(opt)
                if value in (None, ""):
                    continue
                if isinstance(value, str) and len(value) <= MAX_FIELD_LEN and _normalise(value) in source:
                    clean[opt] = value.strip()
                else:
                    out.fields_cleared += 1
            if slug in accepted[label]:
                out.drop("duplicate")
                continue
            accepted[label].add(slug)
            out.entities[key].append(clean)

    rels = extracted.get("relationships")
    if rels is not None and not isinstance(rels, list):
        out.drop("schema")
        rels = []
    for index, rel in enumerate(rels or []):
        if index >= MAX_RELATIONSHIPS:
            out.drop("limit", len(rels) - MAX_RELATIONSHIPS)
            break
        if not isinstance(rel, dict):
            out.drop("schema")
            continue
        rel_type = rel.get("type")
        from_id, to_id = rel.get("from_id"), rel.get("to_id")
        from_label = rel.get("from_label", "Person")
        to_label = rel.get("to_label")
        if not all(isinstance(v, str) for v in (rel_type, from_id, to_id, from_label)):
            out.drop("schema")
            continue
        rel_type = rel_type.strip().upper()
        pair = RELATIONSHIP_KINDS.get(rel_type)
        if pair is None:
            out.drop("kind")
            continue
        if to_label is None:
            to_label = pair[1]
        if (from_label, to_label) != pair:
            out.drop("kind")
            continue
        weight = rel.get("weight", 1.0)
        if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not (0.0 <= float(weight) <= 1.0):
            out.drop("schema")
            continue
        src, dst = safe_id(from_id), safe_id(to_id)
        if src not in accepted[pair[0]] or dst not in accepted[pair[1]]:
            out.drop("unknown_endpoint")
            continue
        if rel_type == "WORKED_WITH" and src == dst:
            out.drop("schema")
            continue
        out.relationships.append({
            "from_id": src, "from_label": pair[0], "to_id": dst, "to_label": pair[1],
            "type": rel_type, "weight": float(weight),
        })
    return out


def check_node(label: str, node_id, name, auth) -> str | None:
    """Why a direct ``merge_*`` call may not write, or ``None``."""
    if not caller_may_write(auth):
        return "tenant"
    if not isinstance(node_id, str) or not isinstance(name, str):
        return "schema"
    slug = safe_id(node_id)
    if not name.strip() or len(name) > MAX_NAME_LEN or not slug.strip("_") or len(slug) > MAX_ID_LEN:
        return "schema"
    if label not in ENTITY_KINDS.values():
        return "kind"
    return None


def check_edge(rel_type, from_label, to_label, auth) -> str | None:
    """Why a direct ``merge_relationship`` call may not write, or ``None``.
    The type itself is checked by the tool's table allow-list."""
    if not caller_may_write(auth):
        return "tenant"
    if not isinstance(rel_type, str):
        return "schema"
    pair = RELATIONSHIP_KINDS.get(rel_type.strip().upper())
    if pair is not None and (from_label, to_label) != pair:
        return "kind"
    return None
