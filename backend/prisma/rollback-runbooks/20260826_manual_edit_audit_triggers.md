# Rollback runbook — 20260826_manual_edit_audit_triggers

**Type:** irreversible (security posture) · **Reviewed:** required before merge

## What the migration does

Creates the `log_manual_table_edit()` function, attaches audit triggers to
`Applicant`, `VerificationResult` and `LoanApplication`, and revokes
`INSERT, UPDATE, DELETE` on `AuditLog` from `PUBLIC`.

## Why it is not automatically reversible

Dropping the triggers is easy, but reversing the `REVOKE` (i.e. granting direct
DML back to `PUBLIC` on the audit table) weakens the audit guarantee and must be
an explicit, reviewed decision rather than an automated rollback.

## Rollback procedure

1. Confirm the operator has approved re-opening direct writes to `AuditLog`.
2. Detach the triggers:
   ```sql
   DROP TRIGGER IF EXISTS trg_applicant_audit ON "Applicant";
   DROP TRIGGER IF EXISTS trg_verification_result_audit ON "VerificationResult";
   DROP TRIGGER IF EXISTS trg_loan_application_audit ON "LoanApplication";
   DROP FUNCTION IF EXISTS log_manual_table_edit();
   ```
3. Restore the pre-migration grants only if the approved change requires it:
   `GRANT INSERT, UPDATE, DELETE ON TABLE "AuditLog" TO PUBLIC;`
4. Re-run the audit-write tests to confirm the intended access level.

## Verification

- Trigger functions are gone (`\df log_manual_table_edit` returns nothing).
- The audit table's ACL matches the approved posture.
