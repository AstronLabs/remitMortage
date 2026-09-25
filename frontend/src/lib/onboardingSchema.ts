// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * Validation schemas for the multi-step borrower onboarding wizard.
 *
 * Each step of the wizard maps to one of the schemas below. They are also
 * composed into a single `onboardingSchema` so a `react-hook-form` resolver can
 * validate the whole form, while `trigger()` validates only the fields that
 * belong to the active step (see `STEP_FIELDS`).
 */

// Stellar G... public key: starts with G, exactly 56 alphanumeric chars.
export const stellarAddressSchema = z
  .string()
  .trim()
  .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address — must start with G and be 56 characters");

// Step 2 — remittance recipient (address parameters).
export const addressSchema = z.object({
  recipientAddress: stellarAddressSchema,
});

// Step 3 — savings goal (income / down-payment & schedule parameters).
export const savingsGoalSchema = z.object({
  savingsTarget: z
    .number({ message: "Enter a numeric savings goal" })
    .min(500, "Goal must be at least $500")
    .max(1_000_000, "Goal must be at most $1,000,000"),
  savingsDuration: z.union([z.literal(6), z.literal(9), z.literal(12)], {
    message: "Duration must be 6, 9, or 12 months",
  }),
});

// Step 4 — first deposit (asset / funding parameters).
export const depositSchema = z.object({
  firstDepositAmount: z
    .number({ message: "Enter a numeric deposit amount" })
    .positive("Deposit must be greater than 0"),
});

// Full onboarding form schema used by the react-hook-form resolver.
export const onboardingSchema = addressSchema.merge(savingsGoalSchema).merge(depositSchema);

export type OnboardingFormValues = z.infer<typeof onboardingSchema>;

// Fields that must be valid before the user may advance past each step.
export const STEP_FIELDS: Record<number, (keyof OnboardingFormValues)[]> = {
  1: [], // Connect Wallet — gated by wallet connection, not form values.
  2: ["recipientAddress"],
  3: ["savingsTarget", "savingsDuration"],
  4: ["firstDepositAmount"],
};
