#!/usr/bin/env python3
"""Apply seed data with per-statement retry.

Freshly-created Aurora clusters intermittently throw
HttpEndpointNotEnabledException from the Data API for a while after creation
(frontend fleet propagation) — the shell apply-*.sh scripts have no retry and
die mid-file. This driver retries those (and throttles) with backoff.

Run from repo root:  python3 schema/apply_all_seed.py
"""
import os
import sys
import time

sys.path.insert(0, 'schema')
from load_schema import split_sql, get_cluster_info  # noqa: E402
import boto3  # noqa: E402

RETRYABLE = ('HttpEndpointNotEnabledException', 'ThrottlingException', 'StatementTimeoutException')

FILES = [
    'schema/seed.sql',
    'schema/orgiq_work_items_schema.sql',
    'schema/seed_work_items_rich.sql',
    'schema/seed_kb_registry.sql',
]


def main() -> int:
    arn, sec, db = get_cluster_info()
    rds = boto3.client('rds-data', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
    total_fail = 0

    for path in FILES:
        stmts = split_sql(open(path, encoding='utf-8').read())
        ok = skipped = failed = 0
        for st in stmts:
            for attempt in range(6):
                try:
                    rds.execute_statement(resourceArn=arn, secretArn=sec, database=db, sql=st)
                    ok += 1
                    break
                except Exception as e:
                    msg = str(e)
                    if 'already exists' in msg or 'duplicate key' in msg:
                        skipped += 1
                        break
                    if any(r in msg for r in RETRYABLE) and attempt < 5:
                        time.sleep(2 * (attempt + 1))
                        continue
                    failed += 1
                    print(f'  FAIL [{path}] {st[:70].replace(chr(10), " ")} -> {msg[:120]}')
                    break
        print(f'{path}: {ok} ok, {skipped} skipped, {failed} failed / {len(stmts)}')
        total_fail += failed

    return 1 if total_fail else 0


if __name__ == '__main__':
    sys.exit(main())
