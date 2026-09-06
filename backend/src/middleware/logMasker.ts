import { Request, Response, NextFunction } from "express";

const SENSITIVE_PATTERNS: RegExp[] = [
  /password/i,
  /secret/i,
  /token/i,
  /apikey/i,
  /api_key/i,
  /authorization/i,
  /x-auth-token/i,
  /bearer/i,
  /passport/i,
  /national[_-]?id/i,
  /driver.?licen[cs]e/i,
  /ssn/i,
  /social_security/i,
  /bank_account/i,
  /routing_number/i,
  /credit_card/i,
  /cvv/i,
  /pin/i,
  /private_key/i,
  /private[_-]?key/i,
  /secret_key/i,
  /wallet_seed/i,
  /mnemonic/i,
  /signature/i,
];

const SENSITIVE_FIELD_NAMES = new Set(
  SENSITIVE_PATTERNS.map((p) => p.source.replace(/\\/g, "").replace(/\/i/g, "").toLowerCase())
);

const MASK = "***";

function maskSensitiveValues(value: unknown, depth = 0): unknown {
  if (depth > 10) return value;

  if (typeof value === "string") {
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(value)) {
        return MASK;
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveValues(item, depth + 1));
  }

  if (value && typeof value === "object") {
    const masked: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const keyLower = key.toLowerCase();
      if (SENSITIVE_PATTERNS.some((p) => p.test(keyLower))) {
        masked[key] = MASK;
      } else if (typeof val === "string" && SENSITIVE_PATTERNS.some((p) => p.test(val))) {
        masked[key] = MASK;
      } else {
        masked[key] = maskSensitiveValues(val, depth + 1);
      }
    }
    return masked;
  }

  return value;
}

export function maskSensitiveData(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  return maskSensitiveValues(body);
}

export function logMasker(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
    req.maskedBody = maskSensitiveData(req.body);
  }
  next();
}

declare global {
  namespace Express {
    interface Request {
      maskedBody?: unknown;
    }
  }
}
