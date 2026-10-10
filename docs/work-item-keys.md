Work items have an immutable public key, such as `ORG-OBS-11`, in addition to
their existing internal `wi-*` ID. Use the public key in commit messages and PRs:
`ORG-OBS-11: group alerts by failing dependency`. The platform includes that key
when it commits a governed work-item run. Existing URLs and foreign keys keep
using the internal ID.

`schema/seeds/work_item_keys.json` reserves the initiative prefixes and all
seeded item keys in version control. Keep existing reservations when an item
is removed or renamed; never renumber them. New work receives the next number
from its initiative's database counter, including epics, stories and bugs.
Deleting work does not return a number to the pool.

Regenerate the runtime mapping, migration and program seed after adding seed work:

```sh
python3 schema/seeds/generate_work_item_keys.py
python3 schema/seeds/generate_program_seed.py
python3 schema/seeds/generate_work_item_keys.py --check
```

Apply `schema/work_item_key_schema.sql` after `orgiq_work_items_schema.sql` and
before loading the program seed. It backfills existing rows, preserves published
keys on rerun, rejects key changes, and serializes concurrent allocations per
initiative. It is included in `schema/load_schema.py` and `schema/apply-work-items.sh`.
The middleware continues to read older databases with a null public key until
the migration is applied. The local mock fixture already uses the same mapping.

The `ORG` prefix is a stable reference namespace; the tenant's display name is Work.
