"""Tests for the RDS Data API result-size guard.

Run:

    cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_result_size_guard
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _shared.result_size_guard import (  # noqa: E402
    RESULT_TOO_LARGE,
    is_result_size_error,
    result_size_error,
)


class _FakeUnsupportedResultException(Exception):
    """Stands in for the class botocore's error factory generates at runtime
    (``_rds.exceptions.UnsupportedResultException``) — matched by class name
    in the guard, so a plain Exception subclass with that name is enough to
    exercise it without a boto3 dependency."""


_FakeUnsupportedResultException.__name__ = "UnsupportedResultException"


class _FakeBadRequestException(Exception):
    pass


_FakeBadRequestException.__name__ = "BadRequestException"


class _FakeUnrelatedClientError(Exception):
    pass


_FakeUnrelatedClientError.__name__ = "DatabaseErrorException"


def _named(cls_name: str, message: str) -> Exception:
    """Build an exception instance whose class __name__ is `cls_name` — the
    same trick botocore's error factory uses (classes generated per service
    error shape), done here without importing botocore."""
    cls = type(cls_name, (Exception,), {})
    return cls(message)


class DetectsTheSizeFailure(unittest.TestCase):
    def test_unsupported_result_exception_with_size_message(self):
        exc = _named(
            "UnsupportedResultException",
            "An error occurred (UnsupportedResultException) when calling the "
            "ExecuteStatement operation: The size was too large.",
        )
        self.assertTrue(is_result_size_error(exc))

    def test_troubleshooting_guide_wording(self):
        exc = _named("UnsupportedResultException", "Database response exceeded size limit")
        self.assertTrue(is_result_size_error(exc))

    def test_per_row_packet_too_large_variant(self):
        exc = _named("UnsupportedResultException", "Packet for query is too large")
        self.assertTrue(is_result_size_error(exc))

    def test_bad_request_exception_serverless_v1_wording(self):
        # This project runs Aurora Serverless v2, so UnsupportedResultException
        # is the one that actually fires — but BadRequestException carries the
        # same failure on Serverless v1, and the class-name match must not be
        # narrowed to only the v2 name.
        exc = _named("BadRequestException", "Database response exceeded size limit")
        self.assertTrue(is_result_size_error(exc))

    def test_case_insensitive_message_match(self):
        exc = _named("UnsupportedResultException", "DATABASE RESPONSE EXCEEDED SIZE LIMIT")
        self.assertTrue(is_result_size_error(exc))


class DoesNotOverclaim(unittest.TestCase):
    """UnsupportedResultException and BadRequestException both cover other
    conditions too — the guard must not treat every instance of those classes
    as a size failure, only ones whose message says so."""

    def test_unsupported_result_exception_for_a_data_type_is_not_a_size_error(self):
        exc = _named(
            "UnsupportedResultException",
            "The result contains a multidimensional array, which isn't supported.",
        )
        self.assertFalse(is_result_size_error(exc))

    def test_bad_request_exception_for_a_sql_typo_is_not_a_size_error(self):
        exc = _named("BadRequestException", "syntax error at or near 'SLECT'")
        self.assertFalse(is_result_size_error(exc))

    def test_unrelated_exception_class(self):
        exc = _named("DatabaseErrorException", "The size was too large")
        self.assertFalse(is_result_size_error(exc))

    def test_statement_timeout_is_not_a_size_error(self):
        exc = _named("StatementTimeoutException", "The execution of the SQL statement timed out.")
        self.assertFalse(is_result_size_error(exc))

    def test_plain_value_error_is_not_a_size_error(self):
        self.assertFalse(is_result_size_error(ValueError("Database response exceeded size limit")))


class ErrorHelperTests(unittest.TestCase):
    def test_returns_none_for_an_unrelated_exception(self):
        self.assertIsNone(result_size_error(ValueError("boom")))

    def test_returns_the_actionable_message(self):
        exc = _named("UnsupportedResultException", "Database response exceeded size limit")
        msg = result_size_error(exc)
        self.assertEqual(msg, RESULT_TOO_LARGE)
        # It should read as guidance, not as an AWS-internal phrase repeated
        # back — the same bar sql_guard.py sets for its own rejections.
        self.assertIn("LIMIT", msg)
        self.assertNotIn("UnsupportedResultException", msg)


if __name__ == "__main__":
    unittest.main(verbosity=2)
