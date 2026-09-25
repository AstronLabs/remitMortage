// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma } from "./db.js";

export async function logAudit(params: {
  action: string;
  actorAddress?: string;
  ipAddress?: string;
  metadata?: any;
}) {
  try {
    // Fire and forget, don't await so we don't block the request.
    // .catch handles any promise rejections so the app doesn't crash.
    prisma.auditLog
      .create({
        data: {
          action: params.action,
          actorAddress: params.actorAddress,
          ipAddress: params.ipAddress,
          metadata: params.metadata ?? {},
        },
      })
      .catch((err: unknown) => {
        console.error("Audit log persistence failed:", err);
      });
  } catch (error) {
    // Catch any immediate synchronous errors
    console.error("Audit log sync failure:", error);
  }
}
