// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import fs from "fs";
import os from "os";
import path from "path";
import {
  DEFAULT_PUBLIC_GLOBS,
  globToRegExp,
  loadUnusedExportConfig,
  scanUnusedExports,
  type SourceFile,
} from "../services/unusedExportScan";

function file(filePath: string, content: string): SourceFile {
  return { path: filePath, content };
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "unused-exports-fixture-"));
}

describe("scanUnusedExports", () => {
  it("reports an exported symbol that nothing imports", () => {
    const report = scanUnusedExports([
      file(
        "src/services/example.ts",
        "export function deadHelper() {}\nexport function liveHelper() {}\n"
      ),
      file(
        "src/index.ts",
        'import { liveHelper } from "./services/example.js";\nliveHelper();\n'
      ),
    ]);

    expect(report.unusedExports).toEqual([
      { file: "src/services/example.ts", name: "deadHelper", line: 1 },
    ]);
  });

  it("does not flag an export that another file imports", () => {
    const report = scanUnusedExports([
      file("src/services/example.ts", "export function liveHelper() {}\n"),
      file(
        "src/consumer.ts",
        'import { liveHelper } from "./services/example.js";\nliveHelper();\n'
      ),
    ]);

    expect(report.unusedExports).toEqual([]);
    expect(report.exportedSymbols).toBe(1);
  });

  it("flags an export used only inside its own file (no importer)", () => {
    const report = scanUnusedExports([
      file(
        "src/services/example.ts",
        "export function helper() {}\nhelper();\n"
      ),
    ]);

    expect(report.unusedExports.map((entry) => entry.name)).toEqual(["helper"]);
  });

  it("treats route modules as an intentional public surface", () => {
    const report = scanUnusedExports([
      file("src/routes/example.ts", "export function handler() {}\n"),
    ]);

    expect(report.unusedExports).toEqual([]);
    expect(report.suppressed).toEqual([
      { file: "src/routes/example.ts", name: "handler", line: 1 },
    ]);
  });

  it("treats barrels/index files as an intentional public surface", () => {
    const report = scanUnusedExports([
      file("src/thing/index.ts", 'export { widget } from "./widget.js";\n'),
      file("src/thing/widget.ts", "export function widget() {}\n"),
    ]);

    // `widget` is used via the barrel re-export; the barrel's own re-export is
    // suppressed rather than reported.
    expect(report.unusedExports).toEqual([]);
    expect(report.suppressed).toEqual([
      { file: "src/thing/index.ts", name: "widget", line: 1 },
    ]);
  });

  it("honours the allowlist for a deliberately unused export", () => {
    const report = scanUnusedExports(
      [file("src/services/legacy.ts", "export function keptForExternalConsumer() {}\n")],
      { allowlist: ["src/services/legacy.ts#keptForExternalConsumer"] }
    );

    expect(report.unusedExports).toEqual([]);
    expect(report.suppressed).toEqual([
      {
        file: "src/services/legacy.ts",
        name: "keptForExternalConsumer",
        line: 1,
      },
    ]);
  });

  it("does not flag anything when the module is imported as a whole", () => {
    const report = scanUnusedExports([
      file("src/services/util.ts", "export const a = 1;\nexport const b = 2;\n"),
      file("src/consumer.ts", 'import * as util from "./services/util.js";\n'),
    ]);

    expect(report.unusedExports).toEqual([]);
  });

  it("treats `export *` and dynamic import as whole-module usage", () => {
    const reexport = scanUnusedExports([
      file("src/services/util.ts", "export const a = 1;\n"),
      file("src/barrel.ts", 'export * from "./services/util.js";\n'),
    ]);
    expect(reexport.unusedExports).toEqual([]);

    const dynamic = scanUnusedExports([
      file("src/services/util.ts", "export const a = 1;\n"),
      file("src/consumer.ts", 'const mod = import("./services/util.js");\n'),
    ]);
    expect(dynamic.unusedExports).toEqual([]);
  });

  it("skips default exports", () => {
    const report = scanUnusedExports([
      file("src/services/example.ts", "export default function () {}\n"),
    ]);

    expect(report.exportedSymbols).toBe(0);
    expect(report.unusedExports).toEqual([]);
  });

  it("respects custom publicGlobs and reports the scan totals", () => {
    const report = scanUnusedExports(
      [
        file("src/generated/api.ts", "export const generatedA = 1;\n"),
        file("src/services/example.ts", "export const dead = 1;\n"),
      ],
      { publicGlobs: [...DEFAULT_PUBLIC_GLOBS, "src/generated/**"] }
    );

    expect(report.scannedFiles).toBe(2);
    expect(report.exportedSymbols).toBe(2);
    expect(report.unusedExports).toEqual([
      { file: "src/services/example.ts", name: "dead", line: 1 },
    ]);
  });
});

describe("globToRegExp", () => {
  it("matches route modules and barrels but not unrelated files", () => {
    expect(globToRegExp("src/routes/**").test("src/routes/admin.ts")).toBe(true);
    expect(globToRegExp("src/**/index.ts").test("src/index.ts")).toBe(true);
    expect(globToRegExp("src/**/index.ts").test("src/a/b/index.ts")).toBe(true);
    expect(globToRegExp("src/**/index.ts").test("src/a/b/other.ts")).toBe(false);
    expect(globToRegExp("src/**/index.ts").test("src/index.tsx")).toBe(false);
  });
});

describe("loadUnusedExportConfig", () => {
  it("returns an empty config when the file is missing", () => {
    const root = makeTempDir();
    expect(loadUnusedExportConfig(path.join(root, "does-not-exist.json"))).toEqual(
      {}
    );
  });

  it("reads publicGlobs and allowlist from the config file", () => {
    const root = makeTempDir();
    const configPath = path.join(root, "unused-exports.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        publicGlobs: ["src/generated/**"],
        allowlist: ["src/services/legacy.ts#keptForExternalConsumer"],
      })
    );

    expect(loadUnusedExportConfig(configPath)).toEqual({
      publicGlobs: ["src/generated/**"],
      allowlist: ["src/services/legacy.ts#keptForExternalConsumer"],
    });
  });
});
