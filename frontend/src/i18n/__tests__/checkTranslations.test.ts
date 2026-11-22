// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkTranslations } from "../checkTranslations";

const FRONTEND_ROOT = path.resolve(__dirname, "../../..");
const MESSAGES_DIR = path.join(FRONTEND_ROOT, "src/i18n/messages");
const SRC_DIR = path.join(FRONTEND_ROOT, "src");

describe("Translation key synchronization check (#1003)", () => {
  test("passes cleanly for the repository locale files (en, es, fr)", () => {
    const report = checkTranslations({
      messagesDir: MESSAGES_DIR,
      srcDir: SRC_DIR,
    });
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.locales).toEqual(expect.arrayContaining(["en", "es", "fr"]));
    expect(report.totalKeys).toBeGreaterThan(0);
  });

  test("fails and lists the exact missing key and locale when a key is removed", () => {
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

      const report = checkTranslations({
        messagesDir: tmpMessages,
        srcDir: tmpSrc,
      });

      expect(report.ok).toBe(false);
      expect(report.missingByLocale.es).toContain("nav.connectWallet");
      expect(report.errors).toContain(
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

      const report = checkTranslations({
        messagesDir: tmpMessages,
        srcDir: tmpSrc,
      });

      expect(report.ok).toBe(false);
      expect(report.extraByLocale.fr).toContain("dashboard.untrackedBonusKey");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
