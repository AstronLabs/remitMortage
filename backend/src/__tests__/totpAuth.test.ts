// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  generateBase32Secret,
  generateRecoveryCodes,
  generateTotpCode,
  verifyTotpCode,
  initiateAdmin2FASetup,
  enableAdmin2FA,
  authenticateAdmin2FA,
  getAdmin2FAStatus,
  disableAdmin2FA,
  hashRecoveryCode,
} from "../services/totpAuth.js";

describe("Admin TOTP 2FA Service (#562)", () => {
  const testAdmin = "GBORROWER1ADMINTESTING111111111111111111111111111111";

  afterEach(() => {
    disableAdmin2FA(testAdmin);
  });

  test("generateBase32Secret produces a valid base32 string", () => {
    const secret = generateBase32Secret();
    expect(secret).toBeDefined();
    expect(secret.length).toBeGreaterThanOrEqual(16);
    expect(secret).toMatch(/^[A-Z2-7]+$/);
  });

  test("generateRecoveryCodes produces specified count of formatted codes", () => {
    const codes = generateRecoveryCodes(6);
    expect(codes).toHaveLength(6);
    codes.forEach((code) => {
      expect(code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    });
  });

  test("verifyTotpCode correctly validates generated TOTP code", () => {
    const secret = generateBase32Secret();
    const currentCode = generateTotpCode(secret);
    expect(verifyTotpCode(secret, currentCode)).toBe(true);
    expect(verifyTotpCode(secret, "000000")).toBe(false);
  });

  test("Full enrollment and authentication lifecycle", () => {
    // 1. Initiate setup
    const setup = initiateAdmin2FASetup(testAdmin);
    expect(setup.secret).toBeDefined();
    expect(setup.recoveryCodes).toHaveLength(8);

    // 2. Enable 2FA with valid token
    const token = generateTotpCode(setup.secret);
    const enableRes = enableAdmin2FA(testAdmin, setup.secret, token, setup.recoveryCodes);
    expect(enableRes.success).toBe(true);

    // 3. Verify 2FA status
    const status = getAdmin2FAStatus(testAdmin);
    expect(status.enabled).toBe(true);
    expect(status.remainingRecoveryCodes).toBe(8);

    // 4. Authenticate with valid TOTP code
    const validAuth = authenticateAdmin2FA(testAdmin, generateTotpCode(setup.secret));
    expect(validAuth.authenticated).toBe(true);
    expect(validAuth.method).toBe("totp");

    // 5. Authenticate with single-use backup recovery code
    const recoveryCodeToUse = setup.recoveryCodes[0];
    const recoveryAuth = authenticateAdmin2FA(testAdmin, recoveryCodeToUse);
    expect(recoveryAuth.authenticated).toBe(true);
    expect(recoveryAuth.method).toBe("recovery_code");

    // 6. Verify backup recovery code is invalidated after first use
    const reuseAuth = authenticateAdmin2FA(testAdmin, recoveryCodeToUse);
    expect(reuseAuth.authenticated).toBe(false);

    // 7. Verify remaining recovery code count decremented
    const updatedStatus = getAdmin2FAStatus(testAdmin);
    expect(updatedStatus.remainingRecoveryCodes).toBe(7);
  });
});
