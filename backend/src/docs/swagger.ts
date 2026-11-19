// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import swaggerJsdoc from "swagger-jsdoc";

const apiVersion = process.env.npm_package_version || "0.1.0";

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "RemitMortgage API",
      version: apiVersion,
      description:
        "Express API for remittance-backed mortgage verification and borrower status workflows on Stellar.",
    },
    servers: [
      {
        url: "http://localhost:4000",
        description: "Local development",
      },
      {
        url: "https://testnet.remitmortgage.example.com",
        description: "Stellar testnet environment",
      },
    ],
    tags: [
      {
        name: "Health",
        description: "Service readiness endpoints",
      },
      {
        name: "Admin Devices",
        description:
          "Device binding for admin sessions: enrol a device-held key, list bound devices, revoke one.",
      },
      {
        name: "Verification",
        description: "Remittance history verification endpoints",
      },
      {
        name: "Borrower",
        description: "Borrower escrow and loan status endpoints",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Placeholder for future authenticated endpoints.",
        },
      },
      schemas: {
        // The error envelope the API actually sends. `error` is the stable
        // machine-readable code (see ERROR_CODES.md); the rest are the
        // optional fields handlers and the error middleware add. Response
        // validation (issue #879) fails on anything beyond these, so a new
        // error field has to be documented here first.
        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "string",
              description: "Stable machine-readable error code.",
              example: "not_found",
            },
            message: {
              type: "string",
              description: "Human-readable explanation. Never parsed by clients.",
            },
            statusCode: {
              type: "integer",
              description: "Echo of the HTTP status, added by the error middleware.",
            },
            timestamp: {
              type: "string",
              format: "date-time",
            },
          },
        },
        // Field-level rejection from middleware/validate.ts: identical to
        // ErrorResponse plus the offending field name.
        ValidationErrorResponse: {
          type: "object",
          required: ["error", "field", "message"],
          properties: {
            error: {
              type: "string",
              enum: ["missing_field", "invalid_address", "invalid_network"],
            },
            field: {
              type: "string",
              description: "Request field that failed validation.",
            },
            message: {
              type: "string",
            },
          },
        },
        // One dependency's health, as reported by /api/health.
        HealthComponent: {
          type: "object",
          required: ["status"],
          properties: {
            status: {
              type: "string",
              enum: ["healthy", "unhealthy"],
            },
            latencyMs: {
              type: "integer",
              minimum: 0,
            },
            error: {
              type: "string",
              description: "Present only when status is unhealthy.",
            },
          },
        },
        HealthResponse: {
          type: "object",
          required: ["status", "service", "timestamp"],
          properties: {
            status: {
              type: "string",
              enum: ["ok", "degraded", "shutting_down"],
              example: "ok",
            },
            service: {
              type: "string",
              example: "remitmortgage-api",
            },
            timestamp: {
              type: "string",
              format: "date-time",
            },
            // Absent on the `shutting_down` reply, which answers before any
            // dependency is probed.
            components: {
              type: "object",
              required: ["database", "horizon"],
              properties: {
                database: { $ref: "#/components/schemas/HealthComponent" },
                horizon: { $ref: "#/components/schemas/HealthComponent" },
              },
            },
          },
        },
        VerificationCheckRequest: {
          type: "object",
          required: ["senderAddress", "recipientAddress"],
          properties: {
            senderAddress: {
              type: "string",
              description: "Stellar public key for the remittance sender.",
              pattern: "^G[A-Z2-7]{55}$",
              example: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            },
            recipientAddress: {
              type: "string",
              description: "Stellar public key for the remittance recipient.",
              pattern: "^G[A-Z2-7]{55}$",
              example: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBCJ",
            },
          },
        },
        RemittanceAnalysis: {
          type: "object",
          required: [
            "senderAddress",
            "recipientAddress",
            "totalPayments",
            "totalAmountUSDC",
            "averageAmountUSDC",
            "standardDeviation",
            "selfDealing",
            "firstPayment",
            "lastPayment",
            "spanMonths",
            "eligible",
            "reason",
          ],
          properties: {
            senderAddress: {
              type: "string",
            },
            recipientAddress: {
              type: "string",
            },
            totalPayments: {
              type: "integer",
              minimum: 0,
            },
            totalAmountUSDC: {
              type: "string",
              example: "1250.00",
            },
            averageAmountUSDC: {
              type: "string",
              example: "208.33",
            },
            firstPayment: {
              type: "string",
              format: "date-time",
              nullable: true,
            },
            lastPayment: {
              type: "string",
              format: "date-time",
              nullable: true,
            },
            spanMonths: {
              type: "number",
              minimum: 0,
            },
            standardDeviation: {
              type: "number",
              description:
                "Standard deviation of payment amounts; the consistency input to scoring.",
            },
            selfDealing: {
              type: "boolean",
              description:
                "True when the recipient routes funds back to the sender or another known borrower wallet.",
            },
            eligible: {
              type: "boolean",
            },
            reason: {
              type: "string",
            },
          },
        },
        AdminDeviceEnrollmentResponse: {
          type: "object",
          required: ["deviceId", "fingerprint", "label", "createdAt", "mode", "bound"],
          properties: {
            deviceId: { type: "string", format: "uuid" },
            fingerprint: {
              type: "string",
              description: "SHA-256 of the enrolled public key; the session's `dbk` claim.",
              pattern: "^[0-9a-f]{64}$",
            },
            label: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            mode: { type: "string", enum: ["off", "monitor", "enforce"] },
            bound: { type: "boolean" },
          },
        },
        AdminDevice: {
          type: "object",
          required: ["deviceId", "label", "fingerprint", "createdAt", "lastSeenAt", "revokedAt", "current"],
          properties: {
            deviceId: { type: "string", format: "uuid" },
            label: { type: "string" },
            fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
            createdAt: { type: "string", format: "date-time" },
            lastSeenAt: { type: "string", format: "date-time", nullable: true },
            revokedAt: { type: "string", format: "date-time", nullable: true },
            current: {
              type: "boolean",
              description: "True for the device the calling session is bound to.",
            },
          },
        },
        AdminDeviceListResponse: {
          type: "object",
          required: ["mode", "boundFingerprint", "devices"],
          properties: {
            mode: { type: "string", enum: ["off", "monitor", "enforce"] },
            boundFingerprint: { type: "string", nullable: true },
            devices: {
              type: "array",
              items: { $ref: "#/components/schemas/AdminDevice" },
            },
          },
        },
        AdminDeviceRevokeResponse: {
          type: "object",
          required: ["deviceId", "label", "revokedAt", "revokedReason"],
          properties: {
            deviceId: { type: "string", format: "uuid" },
            label: { type: "string" },
            revokedAt: { type: "string", format: "date-time", nullable: true },
            revokedReason: { type: "string", nullable: true },
          },
        },
        BorrowerStatusResponse: {
          type: "object",
          required: [
            "address",
            "escrow",
            "pool",
            "verificationStatus",
            "creditScore",
            "verification",
            "loan",
          ],
          properties: {
            address: {
              type: "string",
              description: "Borrower Stellar public key.",
              pattern: "^G[A-Z2-7]{55}$",
            },
            escrow: {
              type: "object",
              required: [
                "deposited",
                "target",
                "progress",
                "startLedger",
                "released",
                "withdrawn",
              ],
              properties: {
                deposited: {
                  type: "string",
                  description: "Escrow balance in stroops, as a decimal string.",
                  example: "0",
                },
                target: {
                  type: "string",
                  example: "0",
                },
                // 0-100, not 0-1: computeProgress() returns a percentage.
                progress: {
                  type: "number",
                  minimum: 0,
                  maximum: 100,
                  example: 0,
                },
                startLedger: {
                  type: "integer",
                  nullable: true,
                },
                released: {
                  type: "boolean",
                },
                withdrawn: {
                  type: "boolean",
                },
              },
            },
            pool: {
              type: "object",
              required: ["availableLiquidity"],
              properties: {
                availableLiquidity: {
                  type: "string",
                  example: "0",
                },
              },
            },
            verificationStatus: {
              type: "string",
              description: "Applicant verification state; PENDING when no applicant record exists.",
              example: "PENDING",
            },
            creditScore: {
              type: "integer",
              nullable: true,
              minimum: 0,
              maximum: 100,
            },
            // Null until the borrower has completed a verification run.
            verification: {
              type: "object",
              nullable: true,
              required: [
                "eligible",
                "totalPayments",
                "totalVolume",
                "spanMonths",
                "reportHash",
                "analyzedAt",
              ],
              properties: {
                eligible: { type: "boolean" },
                totalPayments: { type: "integer", minimum: 0 },
                totalVolume: { type: "number", minimum: 0 },
                spanMonths: { type: "number", minimum: 0 },
                reportHash: { type: "string" },
                analyzedAt: { type: "string", format: "date-time" },
              },
            },
            loan: {
              type: "object",
              required: ["status", "principal", "disbursed", "repaid", "outstanding"],
              properties: {
                status: {
                  type: "string",
                  description: '"none" when the borrower has no loan application.',
                  example: "none",
                },
                principal: {
                  type: "string",
                  example: "0",
                },
                disbursed: {
                  type: "string",
                  example: "0",
                },
                repaid: {
                  type: "string",
                  example: "0",
                },
                outstanding: {
                  type: "string",
                  example: "0",
                },
                // Both present only when a loan application exists.
                escrowContractId: {
                  type: "string",
                  nullable: true,
                },
                loanId: {
                  type: "string",
                  nullable: true,
                },
              },
            },
          },
        },
      },
    },
  },
  apis: ["./src/routes/*.ts", "./dist/routes/*.js"],
});
