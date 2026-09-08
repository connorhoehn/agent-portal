# The read-only graph role (`orgiq_graph_reader`)

`search` and `advisor` expose a `query_graph(sql)` tool. The **model** writes
the SQL and the agent executes it verbatim through the RDS Data API. That makes
the credential behind that call the real boundary between a prompt injection
sitting in an ingested document and `DELETE FROM people`.

Until now that boundary was a regex — `agents/_shared/sql_guard.py` — and its
first version had a hole: a data-modifying CTE
(`WITH gone AS (DELETE FROM people RETURNING *) SELECT * FROM gone`) starts with
`WITH`, holds no semicolon, and PostgreSQL runs the DELETE. The guard closes
that now, and it stays. But a regex over SQL an attacker can influence is
always an argument about parsing, and the attacker picks the argument.

`orgiq_graph_reader` is a role that **cannot write**, which is a fact the
engine enforces rather than a claim a regex makes.

## What the role holds — the exact grants

Created by `schema/graph_readonly_role.sql`. The complete privilege set:

| Grant | Object |
|---|---|
| `CONNECT` | the `orgiq` database |
| `USAGE` (never `CREATE`) | schema `public` |
| `SELECT` | `people`, `skills`, `teams`, `projects`, `decisions`, `documents` |
| `SELECT` | `person_skills`, `team_memberships`, `collaborations`, `project_contributions`, `decision_participants`, `mentions` |
| `SELECT` | `knowledge_bases` |

That is all of it. No `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`,
`TRIGGER`; no sequence or function privileges; no privileges on any other
schema; **no `ALTER DEFAULT PRIVILEGES`**, so the list cannot grow when a
migration adds a table.

The thirteen tables are exactly the ones `query_graph`'s docstring describes to
the model in `agents/search/main.py` and `agents/advisor/main.py`, plus
`knowledge_bases`, which `agents/_shared/kb_resolver.py` reads to resolve a KB
id. Anything the model asks for outside that set gets `permission denied` —
including `node_embeddings`, which is deliberately **not** granted because the
model is never told it exists.

Role attributes: `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
`NOREPLICATION`, `NOBYPASSRLS`, owns nothing. Session defaults:

- `default_transaction_read_only = on` — belt on the braces. Even if someone
  later grants this role `INSERT` by mistake, PostgreSQL refuses the write,
  because the Data API runs every statement in its own implicit transaction.
- `statement_timeout = '30s'` — a model-authored cartesian join cannot pin
  Aurora at 4 ACU.
- `search_path = public` — an object planted in another schema cannot shadow a
  graph table.

The file ends by asking the catalog whether any of that failed (a non-`SELECT`
privilege, an escalation attribute, an owned object) and raising if so, so a
partial apply fails loudly instead of reporting success on a role that can
write.

**The password is not in the file.** `OrgIQ-Aurora` mints
`orgiq-aurora-readonly-credentials` in Secrets Manager with a generated
password; `schema/apply_all_seed.py` reads that secret and issues the single
`ALTER ROLE … PASSWORD` that joins the two. Until that runs the role cannot
authenticate at all — the failure mode is "reads stop", never "reads succeed as
someone who can write".

## How the fallback behaves

`agents/_shared/db_credentials.py` decides which secret a read uses:

```
AURORA_READONLY_SECRET_ARN set   → read as orgiq_graph_reader
AURORA_READONLY_SECRET_ARN unset → read as the cluster admin user (today's behaviour)
```

So an environment that has not applied the grant — a fresh cluster, a local
`agentcore dev`, a rebuild half-way through this runbook — behaves exactly as
it did before the role existed. Nothing breaks, and `sql_guard.py` is once
again the whole boundary there. The agent logs which state it is in at start
(`orgiq.db: query_graph reads as …`), because "the role is enforced" and "the
role is not enforced" are otherwise indistinguishable from outside.

The fallback is on **absence only, never on error**. Once the read-only ARN is
set, a `permission denied for table people` means the grant is missing, and the
query fails. Retrying it on the admin credential would hand an attacker the
writable path by way of a failure they can provoke on purpose.

On the IAM side the swap is exclusive, not additive: with
`--context readOnlyGraphRole=true`, the `search` and `advisor` execution roles
get `secretsmanager:GetSecretValue` on the read-only secret **instead of** the
admin secret. A read agent that can still fetch the admin credential has no
boundary. Every other agent — ingestion, graph-builder, scoring, supervisor,
the two assessment agents — keeps the admin secret unchanged.

## Deploy runbook — in this order

Steps 1–3 are safe on a running fleet and change nothing about how the agents
behave. Step 4 is the switch.

**1. Deploy `OrgIQ-Aurora`** — mints the secret and the CFN export
`orgiq-aurora-readonly-secret-arn`.

```bash
cd infra && ./scripts/deploy.sh OrgIQ-Aurora
```

> Rebuild note: CloudFormation deletes a secret with a recovery window, so a
> teardown followed by a redeploy inside that window fails with *"already
> scheduled for deletion"* on this fixed name. One command clears it:
> `aws secretsmanager delete-secret --secret-id orgiq-aurora-readonly-credentials --force-delete-without-recovery`

**2. Apply the SQL** — creates the role, revokes everything, grants the
allow-list, then reads the secret and sets the password. Idempotent; safe to
re-run.

```bash
python3 schema/apply_all_seed.py
```

`graph_readonly_role.sql` is **last** in that file's `FILES` list and has to
be: it grants on tables every earlier file creates. Run `schema/load_schema.py`
first on a fresh cluster, as usual.

Expected tail of the output:

```
schema/graph_readonly_role.sql: N ok, 0 skipped, 0 failed / N
orgiq-aurora-readonly-credentials: setting orgiq_graph_reader password
  ✓ orgiq_graph_reader can now authenticate
    SELECT           True
    INSERT           False
    UPDATE           False
    DELETE           False
    CREATE on schema False
    owned objects    0
  ✓ read-only boundary confirmed by the engine
```

**3. Verify by hand** (optional — step 2 already asserts it, but this is the
proof a reviewer will want to run themselves). Attempt a write *as the role*,
through the same Data API path the agents use:

```bash
RO_ARN=$(aws secretsmanager describe-secret \
  --secret-id orgiq-aurora-readonly-credentials --query ARN --output text)
CLUSTER=$(aws cloudformation describe-stacks --stack-name OrgIQ-Aurora \
  --query "Stacks[0].Outputs[?OutputKey=='ClusterArn'].OutputValue" --output text)

# Must succeed
aws rds-data execute-statement --resource-arn "$CLUSTER" --secret-arn "$RO_ARN" \
  --database orgiq --sql "SELECT count(*) FROM people"

# Each of these must be REFUSED BY POSTGRES, not by the guard
aws rds-data execute-statement --resource-arn "$CLUSTER" --secret-arn "$RO_ARN" \
  --database orgiq --sql "DELETE FROM people WHERE id = 'nobody'"
aws rds-data execute-statement --resource-arn "$CLUSTER" --secret-arn "$RO_ARN" \
  --database orgiq --sql "INSERT INTO people (id, name) VALUES ('x', 'X')"
aws rds-data execute-statement --resource-arn "$CLUSTER" --secret-arn "$RO_ARN" \
  --database orgiq --sql "UPDATE people SET expertise_score = 1"
aws rds-data execute-statement --resource-arn "$CLUSTER" --secret-arn "$RO_ARN" \
  --database orgiq --sql "CREATE TABLE evil (id text)"
# ...and the CTE that beat the original regex
aws rds-data execute-statement --resource-arn "$CLUSTER" --secret-arn "$RO_ARN" \
  --database orgiq \
  --sql "WITH gone AS (DELETE FROM people RETURNING *) SELECT count(*) FROM gone"
```

Expected error on each write: `cannot execute DELETE in a read-only
transaction` (from `default_transaction_read_only`) or `permission denied for
table people` (from the absent grant). Either is the database refusing —
which is the whole point. A `permission denied for schema public` on the
`CREATE` is the same result.

**4. Redeploy the runtimes with the role turned on.** Opt-in, so nothing flips
until the two steps above are done:

```bash
cd infra && ./scripts/deploy.sh OrgIQ-AgentCoreRuntime \
  --context deployRuntimes=true --context readOnlyGraphRole=true
```

This sets `AURORA_READONLY_SECRET_ARN` on the `search` and `advisor` runtimes
only, and swaps their secret grant. Synth warns on every deploy that leaves the
flag off, in the same spirit as `albAllowCidr` — a security posture that is off
by default has to say so, or "off" quietly becomes "forever".

**5. Confirm in the logs.** Each agent's first line names the boundary that is
actually live:

```
orgiq.db: query_graph reads as orgiq_graph_reader — writes are refused by the database, not only by sql_guard
```

## Rolling back

Redeploy step 4 without `--context readOnlyGraphRole=true`. The env var goes
away, `db_credentials.read_secret_arn()` falls back to the admin secret, and
the fleet is exactly where it was. The database role can stay — it costs
nothing and holds no privileges anyone else uses. In an incident where the role
itself is the problem, `ALTER ROLE orgiq_graph_reader NOLOGIN` is the kill
switch (and makes both read agents fail closed rather than fail open).

## Adding a table to the allow-list

Add it to the `READABLE` array in `schema/graph_readonly_role.sql`, add it to
`EXPECTED` in `agents/tests/test_readonly_role.py`, re-run
`python3 schema/apply_all_seed.py`. Two edits on purpose: the test is the
review step. Do not reach for `ALTER DEFAULT PRIVILEGES`.

## What is tested, and what a test cannot tell you

`agents/tests/test_readonly_role.py` runs offline and proves the SQL grants
nothing but `SELECT`/`USAGE`/`CONNECT` in any spelling, that the role carries no
escalation attribute and owns nothing, that the allow-list is exact and every
entry traces to a real consumer, that no password is committed, and that the
agents send the read-only ARN when it is configured and never retry a failure
on the admin one.

It cannot prove PostgreSQL refused a `DELETE` — only PostgreSQL can say that.
`schema/apply_all_seed.py`'s `verify_readonly_role` asks it on every apply and
fails the run if the answer is wrong; step 3 above is the same question asked
by hand. Neither has been run against the live cluster from the change that
introduced this file.
