// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Unused-export detection for the backend source tree (issue #1032).
 *
 * Dead exports accumulate silently: a helper outlives its last caller and
 * nothing flags it. This module parses every scanned TypeScript file with the
 * compiler API, records which symbols each file exports, and cross-references
 * those against the symbols imported anywhere else in the scan set. An export
 * with no importer is reported — unless it is part of an intentional public
 * surface (route handlers, barrel/index re-exports, deliberately kept exports).
 *
 * The scanning core ({@link scanUnusedExports}) is a pure function over an
 * in-memory list of files, so the detection logic can be exercised without
 * touching the filesystem.
 */

import fs from "fs";
import path from "path";
import ts from "typescript";

/** A source file handed to the scanner. `path` is relative to the scan root. */
export interface SourceFile {
  path: string;
  content: string;
}

/** An exported symbol that has no importer anywhere in the scan set. */
export interface UnusedExport {
  file: string;
  name: string;
  /** 1-based line number of the export declaration. */
  line: number;
}

export interface UnusedExportConfig {
  /**
   * Glob patterns (relative to the scan root) whose exports are considered an
   * intentional public API and never reported — e.g. route modules and barrels.
   */
  publicGlobs?: string[];
  /**
   * Individual `<file>#<name>` entries kept deliberately (e.g. an export
   * retained for an external consumer). Documented in
   * `docs/UNUSED_EXPORT_DETECTION.md`.
   */
  allowlist?: string[];
}

/** Glob patterns used to discover files to scan (importers and exporters). */
export const DEFAULT_SCAN_GLOBS = [
  "src/**/*.ts",
  "scripts/**/*.ts",
  "prisma/**/*.ts",
  "load-tests/**/*.ts",
] as const;

/** Paths that are never scanned. */
export const DEFAULT_IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/*.d.ts",
] as const;

/**
 * Exports in these files are an intentional public surface and are never
 * reported: route modules (handlers are registered on a router, not imported by
 * name) and barrels/index files (re-exported for external consumers). Extend via
 * the `publicGlobs` field of `unused-exports.config.json`.
 */
export const DEFAULT_PUBLIC_GLOBS = [
  "src/routes/**",
  "src/**/index.ts",
] as const;

/** Shape of the optional `unused-exports.config.json` file. */
export interface UnusedExportConfigFile {
  /** Extra public-surface globs, appended to {@link DEFAULT_PUBLIC_GLOBS}. */
  publicGlobs?: string[];
  /** Individual `<file>#<name>` entries kept deliberately. */
  allowlist?: string[];
}

/**
 * Loads `unused-exports.config.json`. A missing file is not an error — the
 * defaults are sufficient — so the caller gets an empty config.
 */
export function loadUnusedExportConfig(configPath: string): UnusedExportConfigFile {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as UnusedExportConfigFile;
  return {
    publicGlobs: parsed.publicGlobs ?? [],
    allowlist: parsed.allowlist ?? [],
  };
}

export interface UnusedExportReport {
  /** Number of files parsed. */
  scannedFiles: number;
  /** Total exported symbols seen across all files. */
  exportedSymbols: number;
  /** Unused exports that are not covered by a public glob or the allowlist. */
  unusedExports: UnusedExport[];
  /** Unused exports suppressed as intentional public API / allowlisted. */
  suppressed: UnusedExport[];
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Converts a glob to a regular expression. Supports `**` (any number of path
 * segments), `*` (within a segment) and `?` (a single non-separator character).
 */
export function globToRegExp(glob: string): RegExp {
  const normalized = toPosix(glob);
  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        i++;
        if (normalized[i + 1] === "/") {
          i++;
          out += "(?:[^/]+/)*";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("+.^${}()|[]\\".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Every symbol a file exports, by name. Default exports and `export *` are skipped. */
function collectExports(sourceFile: ts.SourceFile): Array<{ name: string; line: number }> {
  const found: Array<{ name: string; line: number }> = [];
  const add = (name: string, node: ts.Node) => found.push({ name, line: lineOf(sourceFile, node) });

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) add(element.name.text, element.name);
      } else if (clause && ts.isNamespaceExport(clause)) {
        add(clause.name.text, clause.name);
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    const isDefault = modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
    if (!exported || isDefault) continue;

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) add(declaration.name.text, declaration.name);
      }
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      if (statement.name && ts.isIdentifier(statement.name)) add(statement.name.text, statement.name);
    }
  }

  return found;
}

interface ImportedNames {
  specifier: string;
  /** Named imports (`import { a } from`), empty when the whole module is pulled in. */
  names: string[];
  /** True for default/namespace/side-effect/dynamic/require imports. */
  wholeModule: boolean;
}

/** Import and re-export references that could mark an export as used. */
function collectImports(sourceFile: ts.SourceFile): ImportedNames[] {
  const hits: ImportedNames[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (!clause) {
        hits.push({ specifier, names: [], wholeModule: true });
        continue;
      }
      if (clause.name) hits.push({ specifier, names: [], wholeModule: true });
      const bindings = clause.namedBindings;
      if (bindings) {
        if (ts.isNamespaceImport(bindings)) {
          hits.push({ specifier, names: [], wholeModule: true });
        } else if (ts.isNamedImports(bindings)) {
          const names = bindings.elements.map((element) => (element.propertyName ?? element.name).text);
          hits.push({ specifier, names, wholeModule: false });
        }
      }
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        const names = clause.elements.map((element) => (element.propertyName ?? element.name).text);
        hits.push({ specifier, names, wholeModule: false });
      } else {
        // `export * from` — the whole target module is surfaced.
        hits.push({ specifier, names: [], wholeModule: true });
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const firstArg = node.arguments[0];
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if ((isDynamicImport || isRequire) && firstArg && ts.isStringLiteral(firstArg)) {
        hits.push({ specifier: firstArg.text, names: [], wholeModule: true });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return hits;
}

/** Resolves a relative import specifier (NodeNext `.js`) to a scanned file. */
function resolveSpecifier(fromFile: string, specifier: string, knownFiles: Set<string>): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const fromDir = path.posix.dirname(fromFile);
  const base = path.posix.normalize(path.posix.join(fromDir, specifier));
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    path.posix.join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    const normalized = path.posix.normalize(candidate);
    if (knownFiles.has(normalized)) return normalized;
  }
  return null;
}

/**
 * Pure scan: given the source files and the public-surface configuration,
 * returns the exports that no other file imports.
 */
export function scanUnusedExports(
  files: readonly SourceFile[],
  config: UnusedExportConfig = {}
): UnusedExportReport {
  const knownFiles = new Set(files.map((file) => path.posix.normalize(toPosix(file.path))));
  const publicMatchers = (config.publicGlobs ?? DEFAULT_PUBLIC_GLOBS).map(globToRegExp);
  const allowlist = new Set(config.allowlist ?? []);

  const exportsByFile = new Map<string, Array<{ name: string; line: number }>>();
  const usedNames = new Map<string, Set<string>>();
  const wholeModuleUsed = new Set<string>();

  for (const file of files) {
    const key = path.posix.normalize(toPosix(file.path));
    const sourceFile = ts.createSourceFile(key, file.content, ts.ScriptTarget.Latest, true);

    const exports = collectExports(sourceFile);
    if (exports.length > 0) exportsByFile.set(key, exports);

    for (const hit of collectImports(sourceFile)) {
      const target = resolveSpecifier(key, hit.specifier, knownFiles);
      if (!target) continue;
      if (hit.wholeModule) {
        wholeModuleUsed.add(target);
        continue;
      }
      let names = usedNames.get(target);
      if (!names) {
        names = new Set<string>();
        usedNames.set(target, names);
      }
      for (const name of hit.names) names.add(name);
    }
  }

  const isPublicPath = (key: string): boolean => publicMatchers.some((matcher) => matcher.test(key));

  let exportedSymbols = 0;
  const unusedExports: UnusedExport[] = [];
  const suppressed: UnusedExport[] = [];

  for (const [file, symbols] of exportsByFile) {
    for (const symbol of symbols) {
      exportedSymbols++;
      if (wholeModuleUsed.has(file)) continue;
      if (usedNames.get(file)?.has(symbol.name)) continue;

      const entry: UnusedExport = { file, name: symbol.name, line: symbol.line };
      if (isPublicPath(file) || allowlist.has(`${file}#${symbol.name}`)) {
        suppressed.push(entry);
      } else {
        unusedExports.push(entry);
      }
    }
  }

  const byLocation = (a: UnusedExport, b: UnusedExport) =>
    a.file === b.file ? a.name.localeCompare(b.name) : a.file.localeCompare(b.file);
  unusedExports.sort(byLocation);
  suppressed.sort(byLocation);

  return {
    scannedFiles: files.length,
    exportedSymbols,
    unusedExports,
    suppressed,
  };
}

/** Recursively discovers the `.ts` files matched by the config globs. */
export function discoverSourceFiles(
  rootDir: string,
  config: UnusedExportConfig & { scanGlobs?: readonly string[]; ignoreGlobs?: readonly string[] } = {}
): string[] {
  const includeMatchers = [...(config.scanGlobs ?? DEFAULT_SCAN_GLOBS)].map(globToRegExp);
  const ignoreMatchers = [...(config.ignoreGlobs ?? DEFAULT_IGNORE_GLOBS)].map(globToRegExp);
  const root = toPosix(rootDir);
  const discovered: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.posix.join(toPosix(dir), entry.name);
      const relative = path.posix.relative(root, full);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
        if (ignoreMatchers.some((matcher) => matcher.test(`${relative}/`))) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!full.endsWith(".ts") || full.endsWith(".d.ts")) continue;
      if (ignoreMatchers.some((matcher) => matcher.test(relative))) continue;
      if (includeMatchers.some((matcher) => matcher.test(relative))) discovered.push(relative);
    }
  };

  walk(root);
  return discovered.sort();
}

/** Reads every discovered file into the in-memory list the scanner consumes. */
export function loadSourceFiles(
  rootDir: string,
  config: UnusedExportConfig & { scanGlobs?: readonly string[]; ignoreGlobs?: readonly string[] } = {}
): SourceFile[] {
  const root = toPosix(rootDir);
  return discoverSourceFiles(root, config).map((relative) => ({
    path: relative,
    content: fs.readFileSync(path.join(root, relative), "utf-8"),
  }));
}
