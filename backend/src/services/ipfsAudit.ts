// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma } from "./db.js";

export interface UnpinAuditInput {
  cid: string;
  proposalId?: string;
  success: boolean;
  pinataStatus?: number;
  error?: string;
}

export async function logUnpinnedCid(input: UnpinAuditInput) {
  return prisma.unpinnedCid.create({
    data: {
      cid: input.cid,
      proposalId: input.proposalId,
      success: input.success,
      pinataStatus: input.pinataStatus,
      error: input.error,
    },
  });
}
