"""Tool functions for notebook 13 (A2A).

Defined in a standalone module so cloudpickle serializes them with clean
globals — no notebook-level protobuf imports that would cause
'google._upb._message' / Descriptor serialization failures.
"""
import os


def find_experts(skill: str, limit: int = 5) -> dict:
    """Find people in the org graph with a given skill.

    Args:
        skill: Skill keyword (case-insensitive contains match against skills.name).
        limit: Maximum results.
    """
    import os
    from google.cloud import bigquery
    _proj = os.environ['GOOGLE_CLOUD_PROJECT']
    _ds = os.environ.get('BQ_DATASET', 'orgiq')
    client = bigquery.Client(project=_proj)
    query = f"""
        SELECT p.name, p.title, s.name AS skill, ps.weight
        FROM `{_proj}.{_ds}.people` p
        JOIN `{_proj}.{_ds}.person_skills` ps ON ps.person_id = p.id
        JOIN `{_proj}.{_ds}.skills` s ON s.id = ps.skill_id
        WHERE LOWER(s.name) LIKE LOWER(@pattern)
        ORDER BY ps.weight DESC
    """
    jc = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter('pattern', 'STRING', f'%{skill}%')]
    )
    rows = list(client.query(query, job_config=jc).result())[:limit]
    return {
        'skill': skill,
        'results': [
            {'name': r['name'], 'title': r['title'], 'skill': r['skill'], 'weight': float(r['weight'])}
            for r in rows
        ],
    }


def get_profile(person_id: str) -> dict:
    """Return a person's top skills from the org graph.

    Args:
        person_id: The person's name or id.
    """
    import os
    from google.cloud import bigquery
    _proj = os.environ['GOOGLE_CLOUD_PROJECT']
    _ds = os.environ.get('BQ_DATASET', 'orgiq')
    client = bigquery.Client(project=_proj)
    query = f"""
        SELECT p.name, p.title, p.department,
               ARRAY_AGG(STRUCT(s.name AS skill, ps.weight) ORDER BY ps.weight DESC LIMIT 5) AS top_skills
        FROM `{_proj}.{_ds}.people` p
        JOIN `{_proj}.{_ds}.person_skills` ps ON ps.person_id = p.id
        JOIN `{_proj}.{_ds}.skills` s ON s.id = ps.skill_id
        WHERE LOWER(p.name) = LOWER(@name) OR p.id = @person_id
        GROUP BY p.name, p.title, p.department
        LIMIT 1
    """
    jc = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter('name', 'STRING', person_id),
            bigquery.ScalarQueryParameter('person_id', 'STRING', person_id),
        ]
    )
    rows = list(client.query(query, job_config=jc).result())
    if not rows:
        return {'id': person_id, 'error': 'not found'}
    r = rows[0]
    return {
        'id': person_id,
        'name': r['name'],
        'title': r['title'],
        'department': r['department'],
        'top_skills': [{'skill': s['skill'], 'weight': float(s['weight'])} for s in r['top_skills']],
    }
