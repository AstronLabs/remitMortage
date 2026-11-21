// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Server-side save points for in-progress multi-step applications (issue #1110).
 *
 * The onboarding wizard saves its step and form values here as the applicant
 * moves between steps, keyed by the authenticated wallet, so the applicant can
 * close the app and resume exactly where they left off — on this or any other
 * device. One record per wallet; each save replaces the previous one.
 */

import { prisma } from "./db.js";

/** Upper bound on steps a wizard may declare; guards against junk input. */
export const MAX_TOTAL_STEPS = 20;
/** Serialized size limit for the saved form values. */
export const MAX_PROGRESS_DATA_BYTES = 16 * 1024;

export interface ApplicationProgress {
  step: number;
  totalSteps: number;
  data: Record<string, unknown>;
  updatedAt: string;
}

export interface ProgressInput {
  step: number;
  totalSteps: number;
  data: Record<string, unknown>;
}

export class InvalidProgressError extends Error {
  readonly code = "invalid_progress" as const;
  constructor(
    message: string,
    readonly field: string
  ) {
    super(message);
    this.name = "InvalidProgressError";
  }
}

interface ProgressDelegate {
  findUnique: (args: { where: { stellarAddress: string } }) => Promise<any | null>;
  upsert: (args: {
    where: { stellarAddress: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }) => Promise<any>;
  deleteMany: (args: { where: { stellarAddress: string } }) => Promise<{ count: number }>;
}

/**
 * Reached through a cast, like `loanReviewStages.ts`, so this module works
 * whether or not the generated client has been regenerated for the new model.
 */
function delegate(): ProgressDelegate {
  return (prisma as any).applicationProgress;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates an untrusted request body into a {@link ProgressInput}. */
export function parseProgressInput(body: unknown): ProgressInput {
  if (!isPlainObject(body)) throw new InvalidProgressError("Body must be an object", "body");
  const { step, totalSteps, data } = body;

  if (!Number.isInteger(totalSteps) || (totalSteps as number) < 1 || (totalSteps as number) > MAX_TOTAL_STEPS) {
    throw new InvalidProgressError(`totalSteps must be an integer between 1 and ${MAX_TOTAL_STEPS}`, "totalSteps");
  }
  if (!Number.isInteger(step) || (step as number) < 1 || (step as number) > (totalSteps as number)) {
    throw new InvalidProgressError("step must be an integer between 1 and totalSteps", "step");
  }
  if (!isPlainObject(data)) throw new InvalidProgressError("data must be an object", "data");
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_PROGRESS_DATA_BYTES) {
    throw new InvalidProgressError(`data must serialize to at most ${MAX_PROGRESS_DATA_BYTES} bytes`, "data");
  }

  return { step: step as number, totalSteps: totalSteps as number, data };
}

function mapProgress(record: any): ApplicationProgress {
  return {
    step: record.step,
    totalSteps: record.totalSteps,
    data: isPlainObject(record.data) ? record.data : {},
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

export async function getApplicationProgress(stellarAddress: string): Promise<ApplicationProgress | null> {
  const record = await delegate().findUnique({ where: { stellarAddress } });
  return record ? mapProgress(record) : null;
}

export async function saveApplicationProgress(
  stellarAddress: string,
  input: ProgressInput
): Promise<ApplicationProgress> {
  const fields = { step: input.step, totalSteps: input.totalSteps, data: input.data };
  const record = await delegate().upsert({
    where: { stellarAddress },
    create: { stellarAddress, ...fields },
    update: fields,
  });
  return mapProgress(record);
}

/** Removes the save point, e.g. once the application has been submitted. */
export async function clearApplicationProgress(stellarAddress: string): Promise<boolean> {
  const { count } = await delegate().deleteMany({ where: { stellarAddress } });
  return count > 0;
}
