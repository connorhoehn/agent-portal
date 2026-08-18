#!/usr/bin/env python3
"""Apply the agentic work schema (jobs / findings / graph proposals).

Run from repo root:  python3 schema/apply_agentic_work.py
"""
import sys

sys.path.insert(0, 'schema')
from load_schema import split_sql, get_cluster_info  # noqa: E402
import boto3  # noqa: E402
import os  # noqa: E402

FILES = ['schema/agentic_work_schema.sql']


def main() -> int:
    arn, sec, db = get_cluster_info()
    rds = boto3.client('rds-data', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
    failed = 0
    for path in FILES:
        stmts = split_sql(open(path, encoding='utf-8').read())
        ok = skipped = 0
        for st in stmts:
            try:
                rds.execute_statement(resourceArn=arn, secretArn=sec, database=db, sql=st)
                ok += 1
            except Exception as exc:  # noqa: BLE001
                msg = str(exc)
                if 'already exists' in msg:
                    skipped += 1
                    continue
                failed += 1
                print(f'  FAIL {st[:70].replace(chr(10), " ")} -> {msg[:140]}')
        print(f'{path}: {ok} ok, {skipped} skipped, {failed} failed / {len(stmts)}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
