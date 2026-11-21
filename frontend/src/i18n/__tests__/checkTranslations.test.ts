// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const FRONTEND_ROOT = path.resolve(__dirname, "../../..");
const SCRIPT_PATH = path.join(FRONTEND_ROOT, "scripts/check-translations.mjs");
const MESSAGES_DIR = path.join(FRONTEND_ROOT, "src/i18n/messages");

describe("Translation key synchronization check (#1003)", () => {
  test("passes cleanly for the repository locale files (en, es, fr)", () => {
    const output = execFileSync(process.execPath, [SCRIPT_PATH], {
      cwd: FRONTEND_ROOT,
      encoding: "utf8",
    });
    expect(output).toContain("Translation check passed");
  });

  test("fails with non-zero exit status and lists the exact missing key and locale when a key is removed", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remit-i18n-test-"));
    const tmpMessages = path.join(tmpDir, "messages");
    const tmpSrc = path.join(tmpDir, "src");
    fs.mkdirSync(tmpMessages, { recursive: true });
    fs.mkdirSync(tmpSrc, { recursive: true });

    try {
      const en = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, "en.json"), "utf8"));
      const es = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, "es.json"), "utf8"));
      const fr = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, "fr.json"), "utf8"));

      // Deliberately remove a key from es.json
      delete es.nav.connectWallet;

      fs.writeFileSync(path.join(tmpMessages, "en.json"), JSON.stringify(en, null, 2));
      fs.writeFileSync(path.join(tmpMessages, "es.json"), JSON.stringify(es, null, 2));
      fs.writeFileSync(path.join(tmpMessages, "fr.json"), JSON.stringify(fr, null, 2));

      const runner = `
        import { checkTranslations } from ${JSON.stringify("file://" + SCRIPT_PATH.replace(/\\/g, "/"))};
        const report = checkTranslations({
          messagesDir: ${JSON.stringify(tmpMessages)},
          srcDir: ${JSON.stringify(tmpSrc)},
        });
        if (!report.ok) {
          console.error(JSON.stringify(report));
          process.exit(1);
        }
      `;

      let failed = false;
      let stderrOutput = "";
      try {
        execFileSync(process.execPath, ["--input-type=module", "-e", runner], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: any) {
        failed = true;
        stderrOutput = String(err.stderr || "");
      }

      expect(failed).toBe(true);
      const parsed = JSON.parse(stderrOutput.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.missingByLocale.es).toContain("nav.connectWallet");
      expect(parsed.errors).toContain(
        'Missing key "nav.connectWallet" in locale "es" (defined in "en").'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("fails when a locale contains an orphaned key not present in default locale en.json", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remit-i18n-orphan-"));
    const tmpMessages = path.join(tmpDir, "messages");
    const tmpSrc = path.join(tmpDir, "src");
    fs.mkdirSync(tmpMessages, { recursive: true });
    fs.mkdirSync(tmpSrc, { recursive: true });

    try {
      const en = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, "en.json"), "utf8"));
      const fr = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, "fr.json"), "utf8"));
      fr.dashboard.untrackedBonusKey = "Clé orpheline";

      fs.writeFileSync(path.join(tmpMessages, "en.json"), JSON.stringify(en, null, 2));
      fs.writeFileSync(path.join(tmpMessages, "fr.json"), JSON.stringify(fr, null, 2));

      const runner = `
        import { checkTranslations } from ${JSON.stringify("file://" + SCRIPT_PATH.replace(/\\/g, "/"))};
        const report = checkTranslations({
          messagesDir: ${JSON.stringify(tmpMessages)},
          srcDir: ${JSON.stringify(tmpSrc)},
        });
        console.log(JSON.stringify(report));
      `;

      const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", runner], {
        encoding: "utf8",
      });
      const report = JSON.parse(stdout.trim());
      expect(report.ok).toBe(false);
      expect(report.extraByLocale.fr).toContain("dashboard.untrackedBonusKey");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
