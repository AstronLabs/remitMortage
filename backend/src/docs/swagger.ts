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
        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "string",
            },
          },
        },
        HealthResponse: {
          type: "object",
          required: ["status", "service", "timestamp"],
          properties: {
            status: {
              type: "string",
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
              example: "GDXU35N4YDZTX4LU6KM2P5WNOWIBLDE2DYUNCCXKMAO4NSV3WVNGLJXZ",
            },
            recipientAddress: {
              type: "string",
              description: "Stellar public key for the remittance recipient.",
              pattern: "^G[A-Z2-7]{55}$",
              example: "GBRO6TWF5WNRQKUER75INAECJVDFKW2PKHV3B6CNBFUYFUOSTWKMHEGB",
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
              type: "integer",
              minimum: 0,
            },
            eligible: {
              type: "boolean",
            },
            reason: {
              type: "string",
            },
          },
        },
        BorrowerStatusResponse: {
          type: "object",
          required: ["address", "escrow", "loan"],
          properties: {
            address: {
              type: "string",
              description: "Borrower Stellar public key.",
              pattern: "^G[A-Z2-7]{55}$",
            },
            escrow: {
              type: "object",
              required: ["deposited", "target", "progress"],
              properties: {
                deposited: {
                  type: "string",
                  example: "0",
                },
                target: {
                  type: "string",
                  example: "0",
                },
                progress: {
                  type: "number",
                  minimum: 0,
                  maximum: 1,
                  example: 0,
                },
              },
            },
            loan: {
              type: "object",
              required: ["status", "principal", "disbursed", "repaid"],
              properties: {
                status: {
                  type: "string",
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
              },
            },
          },
        },
      },
    },
  },
  apis: ["./src/routes/*.ts", "./dist/routes/*.js"],
});
