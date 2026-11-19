// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * `/.well-known/security.txt` (RFC 9116) is the documented, safe channel
 * for a researcher to report a vulnerability. This suite is the fast,
 * every-PR half of the guarantee: the file Next.js will actually serve
 * from `public/` parses and isn't already expired. The live, deployed URL
 * is checked separately and on a schedule by
 * `scripts/check-security-txt-expiry.sh`
 * (`.github/workflows/security-txt-expiry.yml`) — see
 * `devops/SECURITY_TXT_RENEWAL.md`.
 */

import fs from "fs";
import path from "path";

const SECURITY_TXT_PATH = path.join(
  __dirname,
  "../../../public/.well-known/security.txt"
);
const PGP_KEY_PATH = path.join(__dirname, "../../../public/.well-known/pgp-key.txt");

/** Pulls the first value of a single-occurrence RFC 9116 field. */
function field(content: string, name: string): string | null {
  const re = new RegExp(`^${name}:\\s*(.+)$`, "im");
  const match = content.match(re);
  return match ? match[1].trim() : null;
}

describe("/.well-known/security.txt", () => {
  it("is present under the served public/ directory", () => {
    expect(fs.existsSync(SECURITY_TXT_PATH)).toBe(true);
  });

  const content = fs.existsSync(SECURITY_TXT_PATH)
    ? fs.readFileSync(SECURITY_TXT_PATH, "utf8")
    : "";

  it("declares at least one Contact", () => {
    expect(field(content, "Contact")).toBeTruthy();
  });

  it("declares a Policy link", () => {
    expect(field(content, "Policy")).toBeTruthy();
  });

  it("has a well-formed, non-expired Expires field", () => {
    const expires = field(content, "Expires");
    expect(expires).toBeTruthy();

    const expiresAt = new Date(expires as string);
    expect(Number.isNaN(expiresAt.getTime())).toBe(false);

    // The whole point of this test: it starts failing on its own, with no
    // code change, once nobody has renewed the policy in time. Flip this
    // from a hard failure to a console warning only if you deliberately
    // want a grace period — the scheduled live check still enforces it.
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("warns (informationally) when Expires is approaching renewal", () => {
    const expires = field(content, "Expires");
    if (!expires) return;
    const daysLeft = (new Date(expires).getTime() - Date.now()) / 86_400_000;
    if (daysLeft <= 30) {
      // eslint-disable-next-line no-console
      console.warn(
        `security.txt expires in ${Math.max(0, Math.round(daysLeft))} day(s) — ` +
          "renew it (see devops/SECURITY_TXT_RENEWAL.md)."
      );
    }
    // Informational only — the hard gate above already fails once expired,
    // and renewal this far out should not block an unrelated PR.
    expect(true).toBe(true);
  });

  it("points Encryption at a PGP key file that is present and well-formed", () => {
    const encryption = field(content, "Encryption");
    expect(encryption).toBeTruthy();
    expect(fs.existsSync(PGP_KEY_PATH)).toBe(true);

    const key = fs.readFileSync(PGP_KEY_PATH, "utf8");
    expect(key).toContain("-----BEGIN PGP PUBLIC KEY BLOCK-----");
    expect(key).toContain("-----END PGP PUBLIC KEY BLOCK-----");
  });
});
