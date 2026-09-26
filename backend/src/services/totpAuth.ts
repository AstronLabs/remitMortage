// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import crypto from "crypto";
import logger from "../utils/logger.js";

// Rate limiting map for TOTP attempts: key = adminId/wallet, value = { attempts, lockUntil }
const attemptsMap = new Map<string, { attempts: number; lockUntil: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export interface TotpEnrollment {
  adminAddress: string;
  secret: string;
  otpauthUrl: string;
  qrCodeUrl: string;
  recoveryCodes: string[];
}

export interface Admin2FASettings {
  adminAddress: string;
  enabled: boolean;
  secret?: string;
  recoveryCodes?: Array<{ codeHash: string; used: boolean }>;
}

// In-memory store for 2FA settings (mimicking Prisma model for Admin2FA)
const admin2FADB = new Map<string, Admin2FASettings>();

/**
 * Generate a random base32 string for TOTP secrets
 */
export function generateBase32Secret(length = 20): string {
  const buffer = crypto.randomBytes(length);
  const base32Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let secret = "";
  for (let i = 0; i < buffer.length; i++) {
    secret += base32Chars[buffer[i] % 32];
  }
  return secret;
}

/**
 * Generate cryptographically secure random backup recovery codes
 */
export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

/**
 * Hash recovery code for secure storage
 */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

/**
 * Basic HMAC-SHA1 TOTP code generator (RFC 6238)
 */
export function generateTotpCode(secret: string, timeStep = Math.floor(Date.now() / 1000 / 30)): string {
  // Decode base32 secret to buffer
  const base32Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (let i = 0; i < secret.length; i++) {
    const val = base32Chars.indexOf(secret[i].toUpperCase());
    if (val !== -1) {
      bits += val.toString(2).padStart(5, "0");
    }
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substr(i, 8), 2));
  }
  const secretBuffer = Buffer.from(bytes);

  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(0, 0);
  timeBuffer.writeUInt32BE(timeStep, 4);

  const hmac = crypto.createHmac("sha1", secretBuffer).update(timeBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const codeInt =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = (codeInt % 1000000).toString().padStart(6, "0");
  return otp;
}

/**
 * Check if TOTP code matches current or adjacent time windows (+/- 1 step)
 */
export function verifyTotpCode(secret: string, token: string): boolean {
  const currentStep = Math.floor(Date.now() / 1000 / 30);
  for (let errorWindow = -1; errorWindow <= 1; errorWindow++) {
    const expected = generateTotpCode(secret, currentStep + errorWindow);
    if (crypto.timingSafeEqual(Buffer.from(token.trim()), Buffer.from(expected))) {
      return true;
    }
  }
  return false;
}

/**
 * Check rate limit for TOTP verification attempts
 */
export function checkRateLimit(key: string): { allowed: boolean; remainingAttempts: number; retryAfterSec?: number } {
  const now = Date.now();
  const record = attemptsMap.get(key);

  if (record && record.lockUntil > now) {
    const retryAfterSec = Math.ceil((record.lockUntil - now) / 1000);
    return { allowed: false, remainingAttempts: 0, retryAfterSec };
  }

  if (record && record.lockUntil <= now && record.attempts >= MAX_ATTEMPTS) {
    attemptsMap.delete(key);
  }

  const currentAttempts = attemptsMap.get(key)?.attempts || 0;
  return { allowed: true, remainingAttempts: MAX_ATTEMPTS - currentAttempts };
}

/**
 * Register failed TOTP attempt
 */
export function recordFailedAttempt(key: string): { locked: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const record = attemptsMap.get(key) || { attempts: 0, lockUntil: 0 };
  record.attempts += 1;

  if (record.attempts >= MAX_ATTEMPTS) {
    record.lockUntil = now + LOCKOUT_MS;
    attemptsMap.set(key, record);
    logger.warn(`[TOTP] Rate limit exceeded for admin key: ${key}. Account locked for 15 mins.`);
    return { locked: true, retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) };
  }

  attemptsMap.set(key, record);
  return { locked: false };
}

/**
 * Reset rate limit counter on successful authentication
 */
export function clearRateLimit(key: string): void {
  attemptsMap.delete(key);
}

/**
 * Initiate TOTP setup flow for an admin account
 */
export function initiateAdmin2FASetup(adminAddress: string, issuer = "RemitMortgage Admin"): TotpEnrollment {
  const secret = generateBase32Secret();
  const recoveryCodes = generateRecoveryCodes();
  const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(
    adminAddress
  )}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;

  // SVG Data URL generator for QR code display
  const qrCodeUrl = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180"><rect width="180" height="180" fill="%230f172a"/><text x="90" y="90" fill="%2338bdf8" font-size="12" text-anchor="middle">QR:${encodeURIComponent(
    otpauthUrl.slice(0, 30)
  )}...</text></svg>`;

  return {
    adminAddress,
    secret,
    otpauthUrl,
    qrCodeUrl,
    recoveryCodes,
  };
}

/**
 * Enable 2FA after verifying initial setup TOTP token
 */
export function enableAdmin2FA(
  adminAddress: string,
  secret: string,
  token: string,
  recoveryCodes: string[]
): { success: boolean; message: string } {
  const valid = verifyTotpCode(secret, token);
  if (!valid) {
    return { success: false, message: "Invalid verification code" };
  }

  const hashedCodes = recoveryCodes.map((code) => ({
    codeHash: hashRecoveryCode(code),
    used: false,
  }));

  admin2FADB.set(adminAddress.toLowerCase(), {
    adminAddress: adminAddress.toLowerCase(),
    enabled: true,
    secret,
    recoveryCodes: hashedCodes,
  });

  logger.info(`[TOTP] 2FA enabled for admin account: ${adminAddress}`);
  return { success: true, message: "2FA successfully configured and enabled" };
}

/**
 * Authenticate admin login with TOTP code or Backup Recovery Code
 */
export function authenticateAdmin2FA(
  adminAddress: string,
  code: string
): { authenticated: boolean; method?: "totp" | "recovery_code"; error?: string; remainingAttempts?: number } {
  const normalizedKey = adminAddress.toLowerCase();
  const settings = admin2FADB.get(normalizedKey);

  if (!settings || !settings.enabled || !settings.secret) {
    return { authenticated: true }; // 2FA not enabled for this admin account
  }

  // Rate limiting check
  const rateLimit = checkRateLimit(normalizedKey);
  if (!rateLimit.allowed) {
    return {
      authenticated: false,
      error: `Too many failed attempts. Try again in ${rateLimit.retryAfterSec} seconds.`,
    };
  }

  // 1. Try TOTP code verification
  if (verifyTotpCode(settings.secret, code)) {
    clearRateLimit(normalizedKey);
    return { authenticated: true, method: "totp" };
  }

  // 2. Try Backup Recovery Code verification
  const inputHash = hashRecoveryCode(code);
  const recoveryCodeIndex = (settings.recoveryCodes || []).findIndex(
    (rc) => rc.codeHash === inputHash && !rc.used
  );

  if (recoveryCodeIndex !== -1) {
    // Invalidate recovery code so it can only be used once
    settings.recoveryCodes![recoveryCodeIndex].used = true;
    admin2FADB.set(normalizedKey, settings);

    clearRateLimit(normalizedKey);
    logger.info(`[TOTP] Admin ${adminAddress} authenticated using single-use recovery code.`);
    return { authenticated: true, method: "recovery_code" };
  }

  // 3. Failed authentication
  const result = recordFailedAttempt(normalizedKey);
  if (result.locked) {
    return {
      authenticated: false,
      error: "Maximum failed 2FA attempts reached. Account locked for 15 minutes.",
    };
  }

  return {
    authenticated: false,
    error: "Invalid 2FA authentication code or recovery code.",
    remainingAttempts: rateLimit.remainingAttempts - 1,
  };
}

/**
 * Get 2FA status for an admin account
 */
export function getAdmin2FAStatus(adminAddress: string): { enabled: boolean; remainingRecoveryCodes: number } {
  const settings = admin2FADB.get(adminAddress.toLowerCase());
  if (!settings || !settings.enabled) {
    return { enabled: false, remainingRecoveryCodes: 0 };
  }
  const remaining = (settings.recoveryCodes || []).filter((rc) => !rc.used).length;
  return { enabled: true, remainingRecoveryCodes: remaining };
}

/**
 * Disable 2FA for an admin account
 */
export function disableAdmin2FA(adminAddress: string): void {
  admin2FADB.delete(adminAddress.toLowerCase());
  logger.info(`[TOTP] 2FA disabled for admin account: ${adminAddress}`);
}
