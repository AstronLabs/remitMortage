// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import fs from "fs";
import path from "path";

import { listMigrations } from "./migrationRollback.js";

/**
 * Lint for unsafe operations in Prisma migrations (issue #1035).
 *
 * A migration can drop a column the deployed code still reads, add a `NOT NULL`
 * column with no default to a populated table, or take a lock while it builds
 * an index — any of which can fail, or stall production, with nothing catching
 * it before it runs. This module scans a migration's SQL for a documented list
 * of such patterns ({@link UNSAFE_PATTERNS}) so they are caught in review.
 *
 * A migration that genuinely needs one of these operations declares a reviewed
 * waiver inline, the same way `// safe-merge-ok:` works for the unsafe-merge
 * gate:
 *
 *     -- migration-ok: <reason this is safe>
 *
 * The waiver must carry a reason — a bare `-- migration-ok:` does not count.
 * It applies to the statement it sits on (or within), or the line above it.
 *
 * Only migrations added after {@link LINT_INTRODUCED_AFTER} are checked; the
 * migrations that predate the lint are grandfathered in so the gate can land
 * without rewriting history.
 */

export interface UnsafePattern {
  /** Stable identifier reported in findings and accepted in waivers. */
  id: string;
  /** One-line description of the operation. */
  summary: string;
  /** What to do instead. */
  hint: string;
  /**
   * Index of the offending token within a statement, or `null` when the
   * statement is safe. Comments and string literals are already masked out.
   */
  match(statement: string): number | null;
}

function firstIndex(pattern: RegExp, text: string): number | null {
  const found = pattern.exec(text);
  return found ? found.index : null;
}

/**
 * The documented list of unsafe migration operations. Each entry names the
 * operation, why it is unsafe, and how to make it safe. To suppress one on a
 * specific statement, add `-- migration-ok: <reason>`.
 */
export const UNSAFE_PATTERNS: readonly UnsafePattern[] = [
  {
    id: "add-not-null-column-without-default",
    summary: "ADD COLUMN ... NOT NULL with no DEFAULT",
    hint: "add the column nullable, backfill it, then SET NOT NULL in a later migration — or give it a DEFAULT",
    match: (statement) => {
      const add = /\bADD\s+COLUMN\b/i.exec(statement);
      if (!add) return null;
      const clause = statement.slice(add.index).split(/,\s*ADD\s+COLUMN\b/i)[0];
      if (!/\bNOT\s+NULL\b/i.test(clause)) return null;
      if (/\bDEFAULT\b/i.test(clause)) return null;
      return add.index;
    },
  },
  {
    id: "set-not-null",
    summary: "ALTER COLUMN ... SET NOT NULL",
    hint: "add a NOT VALID check constraint, VALIDATE it, then SET NOT NULL in a later migration",
    match: (statement) => firstIndex(/\bSET\s+NOT\s+NULL\b/i, statement),
  },
  {
    id: "alter-column-type",
    summary: "ALTER COLUMN ... TYPE (rewrites the table under a lock)",
    hint: "add a new column, backfill it, and swap the reads over in a later migration",
    match: (statement) => {
      const altered = /\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b/i.exec(statement);
      return altered ? altered.index : null;
    },
  },
  {
    id: "add-foreign-key-without-not-valid",
    summary: "ADD CONSTRAINT ... FOREIGN KEY without NOT VALID",
    hint: "add the constraint as NOT VALID, then VALIDATE CONSTRAINT in a later migration",
    match: (statement) => {
      if (!/\bFOREIGN\s+KEY\b/i.test(statement)) return null;
      if (/\bNOT\s+VALID\b/i.test(statement)) return null;
      return firstIndex(/\bADD\s+CONSTRAINT\b/i, statement) ?? firstIndex(/\bFOREIGN\s+KEY\b/i, statement);
    },
  },
  {
    id: "add-check-constraint-without-not-valid",
    summary: "ADD CONSTRAINT ... CHECK without NOT VALID",
    hint: "add the constraint as NOT VALID, then VALIDATE CONSTRAINT in a later migration",
    match: (statement) => {
      if (!/\bADD\s+CONSTRAINT\b/i.test(statement)) return null;
      if (!/\bCHECK\s*\(/i.test(statement)) return null;
      if (/\bNOT\s+VALID\b/i.test(statement)) return null;
      return firstIndex(/\bADD\s+CONSTRAINT\b/i, statement);
    },
  },
  {
    id: "add-unique-constraint",
    summary: "ADD CONSTRAINT ... UNIQUE (builds an index while holding a lock)",
    hint: "CREATE UNIQUE INDEX CONCURRENTLY, then attach it with ADD CONSTRAINT ... USING INDEX",
    match: (statement) => {
      if (!/\bADD\s+CONSTRAINT\b/i.test(statement)) return null;
      if (!/\bUNIQUE\b/i.test(statement)) return null;
      return firstIndex(/\bADD\s+CONSTRAINT\b/i, statement);
    },
  },
  {
    id: "create-index-without-concurrently",
    summary: "CREATE INDEX without CONCURRENTLY (blocks writes while it builds)",
    hint: "use CREATE INDEX CONCURRENTLY, which runs outside a transaction",
    match: (statement) => {
      const created = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.exec(statement);
      if (!created) return null;
      if (/\bCONCURRENTLY\b/i.test(statement)) return null;
      return created.index;
    },
  },
  {
    id: "drop-column",
    summary: "DROP COLUMN (data loss; deployed code may still read it)",
    hint: "stop reading the column, ship that, then drop it in a later migration",
    match: (statement) => firstIndex(/\bDROP\s+COLUMN\b/i, statement),
  },
  {
    id: "drop-table",
    summary: "DROP TABLE (data loss)",
    hint: "rename the table first and drop it only once nothing references it",
    match: (statement) => firstIndex(/\bDROP\s+TABLE\b/i, statement),
  },
  {
    id: "rename-column-or-table",
    summary: "RENAME COLUMN/TABLE (breaks the currently deployed code)",
    hint: "add the new name, dual-write, then remove the old name in a later migration",
    match: (statement) => firstIndex(/\bRENAME\b/i, statement),
  },
];

interface SqlStatement {
  /** SQL from the first code character up to (not including) the `;`. */
  text: string;
  /** 1-based line of the first code character. */
  startLine: number;
  /** 1-based line of the closing `;` (or the last line when unterminated). */
  endLine: number;
}

/**
 * Splits migration SQL into statements, ignoring `;` inside strings, quoted
 * identifiers and comments. Just enough to scope the checks below — it is not
 * a full SQL parser.
 */
function splitStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  const length = sql.length;
  let index = 0;
  let line = 1;
  let start = -1;
  let startLine = 1;
  let inLineComment = false;
  let inBlockComment = false;
  let inSingle = false;
  let inDouble = false;
  let dollarTag: string | null = null;

  const begin = (at: number, atLine: number) => {
    if (start < 0) {
      start = at;
      startLine = atLine;
    }
  };

  while (index < length) {
    const ch = sql[index];
    const next = sql[index + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        line++;
      }
      index++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        index += 2;
        continue;
      }
      if (ch === "\n") line++;
      index++;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && next === "'") {
        index += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      if (ch === "\n") line++;
      index++;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && next === '"') {
        index += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      if (ch === "\n") line++;
      index++;
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        dollarTag = null;
        continue;
      }
      if (ch === "\n") line++;
      index++;
      continue;
    }

    if (ch === "-" && next === "-") {
      inLineComment = true;
      index += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      index += 2;
      continue;
    }
    if (ch === "\n") {
      line++;
      index++;
      continue;
    }
    if (/\s/.test(ch)) {
      index++;
      continue;
    }
    if (ch === "'") {
      begin(index, line);
      inSingle = true;
      index++;
      continue;
    }
    if (ch === '"') {
      begin(index, line);
      inDouble = true;
      index++;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(index));
      if (tag) {
        begin(index, line);
        dollarTag = tag[0];
        index += tag[0].length;
        continue;
      }
    }
    if (ch === ";") {
      if (start >= 0) {
        statements.push({ text: sql.slice(start, index).trimEnd(), startLine, endLine: line });
        start = -1;
      }
      index++;
      continue;
    }

    begin(index, line);
    index++;
  }

  if (start >= 0) {
    statements.push({ text: sql.slice(start).trimEnd(), startLine, endLine: line });
  }
  return statements;
}

/**
 * Replaces the contents of line/block comments and single-quoted strings with
 * spaces, preserving length and newlines, so a keyword inside prose or a string
 * literal is not mistaken for a statement.
 */
function maskLiteralsAndComments(sql: string): string {
  const out = sql.split("");
  const length = sql.length;
  let index = 0;
  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  const blank = (at: number) => {
    if (out[at] !== "\n") out[at] = " ";
  };

  while (index < length) {
    const ch = sql[index];
    const next = sql[index + 1];

    if (inLineComment) {
      blank(index);
      if (ch === "\n") inLineComment = false;
      index++;
      continue;
    }
    if (inBlockComment) {
      blank(index);
      if (ch === "*" && next === "/") {
        blank(index + 1);
        inBlockComment = false;
        index += 2;
        continue;
      }
      index++;
      continue;
    }
    if (inSingle) {
      blank(index);
      if (ch === "'" && next === "'") {
        blank(index + 1);
        index += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      index++;
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        dollarTag = null;
        continue;
      }
      index++;
      continue;
    }

    if (ch === "-" && next === "-") {
      inLineComment = true;
      blank(index);
      blank(index + 1);
      index += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      blank(index);
      blank(index + 1);
      index += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      blank(index);
      index++;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(index));
      if (tag) {
        dollarTag = tag[0];
        index += tag[0].length;
        continue;
      }
    }
    index++;
  }

  return out.join("");
}

export interface MigrationSqlFinding {
  /** 1-based line of the offending operation. */
  line: number;
  /** Matches an id from {@link UNSAFE_PATTERNS}. */
  pattern: string;
  /** How to make the operation safe. */
  hint: string;
  /** The offending statement, whitespace-collapsed and truncated. */
  statement: string;
}

/** A waiver must name a reason; `-- migration-ok:` on its own does not count. */
const WAIVER = /--\s*migration-ok:\s*\S/i;

function isWaived(lines: string[], statement: SqlStatement): boolean {
  const from = Math.max(0, statement.startLine - 2);
  const to = Math.min(lines.length - 1, statement.endLine - 1);
  for (let index = from; index <= to; index++) {
    if (WAIVER.test(lines[index])) return true;
  }
  return false;
}

/**
 * Scans one migration's SQL and returns the unsafe operations in it. A statement
 * carrying a `-- migration-ok: <reason>` waiver — on its own line, on any line it
 * spans, or on the line directly above — is skipped.
 */
export function scanMigrationSql(sql: string): MigrationSqlFinding[] {
  const lines = sql.split(/\r?\n/);
  const findings: MigrationSqlFinding[] = [];

  for (const statement of splitStatements(sql)) {
    if (isWaived(lines, statement)) continue;
    const masked = maskLiteralsAndComments(statement.text);
    const collapsed = statement.text.replace(/\s+/g, " ").trim();
    for (const pattern of UNSAFE_PATTERNS) {
      const offset = pattern.match(masked);
      if (offset === null) continue;
      const precedingLines = statement.text.slice(0, offset).match(/\n/g);
      findings.push({
        line: statement.startLine + (precedingLines ? precedingLines.length : 0),
        pattern: pattern.id,
        hint: pattern.hint,
        statement: collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed,
      });
    }
  }

  return findings;
}

/**
 * Migration name stamps at or before this predate the lint (issue #1035) and are
 * grandfathered in. Every migration added from now on sorts after it and is
 * checked. Move it forward only deliberately: doing so grandfathers the
 * migrations in between.
 */
export const LINT_INTRODUCED_AFTER = "20261018000000";

/** True when `migration` predates the lint and is skipped by default. */
export function isGrandfathered(migration: string): boolean {
  return migration.slice(0, 14) <= LINT_INTRODUCED_AFTER;
}

export interface MigrationSafetyFinding extends MigrationSqlFinding {
  /** The migration directory the finding is in. */
  migration: string;
}

export interface MigrationSafetyReport {
  ok: boolean;
  /** Migrations that were linted. */
  checked: string[];
  /** Migrations skipped because they predate the lint. */
  grandfathered: string[];
  findings: MigrationSafetyFinding[];
}

/**
 * Lints the migrations in `migrationsDir`. By default only migrations added
 * after {@link LINT_INTRODUCED_AFTER} are checked; pass `all: true`, or an
 * explicit `since` stamp, to widen the scope (useful when auditing history).
 */
export function validateMigrationSafety(opts: {
  migrationsDir: string;
  since?: string;
  all?: boolean;
}): MigrationSafetyReport {
  const since = opts.since ?? LINT_INTRODUCED_AFTER;
  const checked: string[] = [];
  const grandfathered: string[] = [];
  const findings: MigrationSafetyFinding[] = [];

  for (const migration of listMigrations(opts.migrationsDir)) {
    if (!opts.all && migration.slice(0, 14) <= since) {
      grandfathered.push(migration);
      continue;
    }
    checked.push(migration);
    const sql = fs.readFileSync(path.join(opts.migrationsDir, migration, "migration.sql"), "utf-8");
    for (const finding of scanMigrationSql(sql)) {
      findings.push({ migration, ...finding });
    }
  }

  return { ok: findings.length === 0, checked, grandfathered, findings };
}
