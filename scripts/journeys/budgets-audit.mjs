// Budgets at the product's supported desktop widths. No business writes.
import assert from 'node:assert/strict';
import { verifyDesktopAudit } from './desktop-audit.mjs';

const outAt = process.argv.indexOf('--out');
assert.ok(outAt >= 0 && process.argv[outAt + 1], '--out is required');
verifyDesktopAudit('/admin/budgets', process.argv[outAt + 1], process.env.BUDGET_AUDIT_PREVIOUS);
console.log('PASS budgets audit: four desktop width/theme cases, zero findings and complete composer classification');
