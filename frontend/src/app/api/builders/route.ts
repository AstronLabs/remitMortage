// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { getReviewSummary } from "@/lib/builderReviewStore";

/**
 * Builder reputation feed.
 *
 * Completion metrics come from the indexer API when `INDEXER_API_URL` is set;
 * otherwise a deterministic local dataset is served so the Contractor Portal
 * renders in development. Review aggregates are always merged in locally.
 */

const FALLBACK_BUILDERS = [
  {
    id: "bld-001",
    name: "Lagos Structural Works",
    whitelisted: true,
    projectsCompleted: 47,
    projectsTotal: 52,
    avgPayoutDays: 3,
  },
  {
    id: "bld-002",
    name: "Accra BuildCo",
    whitelisted: true,
    projectsCompleted: 28,
    projectsTotal: 36,
    avgPayoutDays: 5,
  },
  {
    id: "bld-003",
    name: "Nairobi Homes Ltd",
    whitelisted: true,
    projectsCompleted: 19,
    projectsTotal: 20,
    avgPayoutDays: 2,
  },
  {
    id: "bld-004",
    name: "Kigali Craft Builders",
    whitelisted: false,
    projectsCompleted: 6,
    projectsTotal: 14,
    avgPayoutDays: 9,
  },
];

interface RawBuilder {
  id: string;
  name: string;
  whitelisted?: boolean;
  projectsCompleted?: number;
  projectsTotal?: number;
  avgPayoutDays?: number;
}

async function loadFromIndexer(): Promise<RawBuilder[] | null> {
  const base = process.env.INDEXER_API_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/builders`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const raw = (await loadFromIndexer()) ?? FALLBACK_BUILDERS;

  const builders = raw.map((b) => {
    const completed = b.projectsCompleted ?? 0;
    const total = b.projectsTotal ?? 0;
    const summary = getReviewSummary(b.id);
    return {
      id: b.id,
      name: b.name,
      whitelisted: b.whitelisted ?? false,
      projectsCompleted: completed,
      projectsTotal: total,
      completionRate: total > 0 ? (completed / total) * 100 : 0,
      avgPayoutDays: b.avgPayoutDays ?? 0,
      averageRating: summary.averageRating,
      reviewCount: summary.reviewCount,
    };
  });

  return NextResponse.json(builders);
}
