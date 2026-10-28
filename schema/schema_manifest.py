"""schema/manifest.json: the one list of schema files and their kinds (DE-20).

Both loaders (load_schema.py, apply_all_seed.py), the migration runner
(migrate.py) and the middleware's PostgreSQL suites read this file, so a new
schema file is registered once.
"""
import hashlib
import json
from pathlib import Path

SCHEMA_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = SCHEMA_DIR / 'manifest.json'
KINDS = ('repeatable', 'versioned', 'data', 'seed')


def load_manifest(path=None):
    """Parse and validate the manifest. Raises ValueError on a malformed one."""
    data = json.loads(Path(path or MANIFEST_PATH).read_text(encoding='utf-8'))
    entries = data.get('entries')
    if not isinstance(entries, list) or not entries:
        raise ValueError('manifest has no entries')
    seen = set()
    for e in entries:
        if e.get('kind') not in KINDS:
            raise ValueError(f"{e.get('id')}: unknown kind {e.get('kind')!r}")
        if not e.get('id') or e['id'] in seen:
            raise ValueError(f"duplicate or missing id {e.get('id')!r}")
        seen.add(e['id'])
        if e['kind'] == 'data':
            if not (e.get('file') or e.get('apply_command')):
                raise ValueError(f"{e['id']}: a data entry needs file or apply_command")
            if not (e.get('dry_run_file') or e.get('dry_run_command')):
                raise ValueError(f"{e['id']}: a data entry needs a dry run")
        elif not e.get('file'):
            raise ValueError(f"{e['id']}: needs file")
    for ref in data.get('seed_run', []):
        if ref not in seen:
            raise ValueError(f'seed_run names unknown entry {ref!r}')
    return data


def schema_files(path=None):
    """What load_schema.py loads: every repeatable entry's file, in order."""
    return [e['file'] for e in load_manifest(path)['entries'] if e['kind'] == 'repeatable']


def seed_run_files(path=None):
    """What apply_all_seed.py runs, as repo-relative paths, in order."""
    data = load_manifest(path)
    by_id = {e['id']: e for e in data['entries']}
    return [f"schema/{by_id[ref]['file']}" for ref in data.get('seed_run', [])]


def entry_checksum(entry, schema_dir=None):
    """sha256 over the entry's definition and every SQL file it names."""
    base = Path(schema_dir or SCHEMA_DIR)
    h = hashlib.sha256()
    # `env` is the operator defaults a command runs with, not what it does.
    spec = {k: v for k, v in entry.items() if k not in ('why', 'env')}
    h.update(json.dumps(spec, sort_keys=True).encode())
    for key in ('file', 'dry_run_file'):
        if entry.get(key):
            h.update(b'\0' + (base / entry[key]).read_bytes())
    return h.hexdigest()
