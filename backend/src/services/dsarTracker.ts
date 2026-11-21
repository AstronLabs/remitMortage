// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import crypto from "crypto";
import { AppError } from "../errors/catalog.js";

export type DsarType = "ACCESS" | "ERASURE" | "RECTIFICATION" | "PORTABILITY" | "RESTRICTION";
export type DsarStatus = "RECEIVED" | "IDENTITY_VERIFIED" | "IN_PROGRESS" | "COMPLETED";

export const DEFAULT_DSAR_STATUTORY_DAYS = 30;
export const DEFAULT_DSAR_WARNING_DAYS = 5;

const ALLOWED_TRANSITIONS: Record<DsarStatus, readonly DsarStatus[]> = {
  RECEIVED: ["IDENTITY_VERIFIED"],
  IDENTITY_VERIFIED: ["IN_PROGRESS"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: [],
};

export interface DsarRequest {
  id: string;
  type: DsarType;
  requester: string;
  receivedAt: string;
  statutoryDeadline: string;
  status: DsarStatus;
  notes?: string;
  deadlineAlertSentAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDsarInput {
  type: DsarType;
  requester: string;
  receivedAt: string | Date;
  statutoryDays?: number;
  notes?: string;
}

export interface DsarDeadlineAlert {
  requestId: string;
  type: DsarType;
  requester: string;
  status: DsarStatus;
  statutoryDeadline: string;
  daysRemaining: number;
}

const dsarStore = new Map<string, DsarRequest>();

export function calculateStatutoryDeadline(
  receivedAt: string | Date,
  statutoryDays = DEFAULT_DSAR_STATUTORY_DAYS
): string {
  const base = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
  if (Number.isNaN(base.getTime())) {
    throw new AppError("VALIDATION_ERROR", "receivedAt must be a valid ISO-8601 date");
  }
  if (!Number.isInteger(statutoryDays) || statutoryDays < 1) {
    throw new AppError("VALIDATION_ERROR", "statutoryDays must be a positive integer");
  }
  const deadline = new Date(base.getTime() + statutoryDays * 24 * 60 * 60 * 1000);
  return deadline.toISOString();
}

export function createDsarRequest(input: CreateDsarInput, now: Date = new Date()): DsarRequest {
  if (!input.requester || input.requester.trim() === "") {
    throw new AppError("VALIDATION_ERROR", "requester is required");
  }
  const receivedDate = input.receivedAt instanceof Date ? input.receivedAt : new Date(input.receivedAt);
  if (Number.isNaN(receivedDate.getTime())) {
    throw new AppError("VALIDATION_ERROR", "receivedAt must be a valid date");
  }
  const days =
    input.statutoryDays ??
    (process.env.DSAR_STATUTORY_DAYS ? parseInt(process.env.DSAR_STATUTORY_DAYS, 10) : DEFAULT_DSAR_STATUTORY_DAYS);

  const nowIso = now.toISOString();
  const record: DsarRequest = {
    id: crypto.randomUUID(),
    type: input.type,
    requester: input.requester.trim(),
    receivedAt: receivedDate.toISOString(),
    statutoryDeadline: calculateStatutoryDeadline(receivedDate, days),
    status: "RECEIVED",
    notes: input.notes,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  dsarStore.set(record.id, record);
  return { ...record };
}

export function getDsarRequest(id: string): DsarRequest | undefined {
  const r = dsarStore.get(id);
  return r ? { ...r } : undefined;
}

export function listDsarRequests(status?: DsarStatus): DsarRequest[] {
  const out: DsarRequest[] = [];
  for (const r of dsarStore.values()) {
    if (!status || r.status === status) {
      out.push({ ...r });
    }
  }
  return out;
}

export function transitionDsarStatus(
  id: string,
  nextStatus: DsarStatus,
  now: Date = new Date()
): DsarRequest {
  const record = dsarStore.get(id);
  if (!record) {
    throw new AppError("DSAR_NOT_FOUND", `DSAR request '${id}' not found`);
  }
  const allowed = ALLOWED_TRANSITIONS[record.status];
  if (!allowed.includes(nextStatus)) {
    throw new AppError(
      "INVALID_STATUS_TRANSITION",
      `Cannot transition DSAR request from ${record.status} to ${nextStatus}`
    );
  }
  record.status = nextStatus;
  record.updatedAt = now.toISOString();
  return { ...record };
}

export function checkApproachingDsarDeadlines(options?: {
  now?: Date;
  warningDays?: number;
  notify?: (alert: DsarDeadlineAlert) => void;
}): DsarDeadlineAlert[] {
  const now = options?.now ?? new Date();
  const warningDays =
    options?.warningDays ??
    (process.env.DSAR_DEADLINE_WARNING_DAYS
      ? parseInt(process.env.DSAR_DEADLINE_WARNING_DAYS, 10)
      : DEFAULT_DSAR_WARNING_DAYS);
  const windowMs = warningDays * 24 * 60 * 60 * 1000;
  const alerts: DsarDeadlineAlert[] = [];

  for (const record of dsarStore.values()) {
    if (record.status === "COMPLETED" || record.deadlineAlertSentAt) {
      continue;
    }
    const remainingMs = new Date(record.statutoryDeadline).getTime() - now.getTime();
    if (remainingMs <= windowMs) {
      const alert: DsarDeadlineAlert = {
        requestId: record.id,
        type: record.type,
        requester: record.requester,
        status: record.status,
        statutoryDeadline: record.statutoryDeadline,
        daysRemaining: Math.ceil(remainingMs / (24 * 60 * 60 * 1000)),
      };
      record.deadlineAlertSentAt = now.toISOString();
      record.updatedAt = record.deadlineAlertSentAt;
      options?.notify?.(alert);
      alerts.push(alert);
    }
  }

  return alerts;
}

export function clearDsarStore(): void {
  dsarStore.clear();
}
