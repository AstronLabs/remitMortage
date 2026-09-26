// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * In-process store for borrower-submitted builder reviews.
 *
 * Deliberately lightweight: reviews are aggregated here and merged into the
 * indexer-sourced builder metrics. Swap the module internals for a database
 * call when review persistence moves to the backend.
 */

import type { BuilderReview } from "./builderReputation";

const SEED: BuilderReview[] = [
  {
    id: "rev-seed-1",
    builderId: "bld-001",
    reviewer: "GBORROWER...EXAMPLE1",
    rating: 5,
    comment: "Foundation and structure milestones both cleared ahead of schedule.",
    createdAt: "2026-05-02T09:15:00.000Z",
  },
  {
    id: "rev-seed-2",
    builderId: "bld-001",
    reviewer: "GBORROWER...EXAMPLE2",
    rating: 4,
    comment: "Solid workmanship, evidence uploads were occasionally late.",
    createdAt: "2026-05-19T14:40:00.000Z",
  },
  {
    id: "rev-seed-3",
    builderId: "bld-002",
    reviewer: "GBORROWER...EXAMPLE3",
    rating: 4,
    comment: "Good communication throughout the roofing milestone.",
    createdAt: "2026-06-08T11:05:00.000Z",
  },
];

const reviews: BuilderReview[] = [...SEED];

export function listReviews(builderId?: string): BuilderReview[] {
  const rows = builderId ? reviews.filter((r) => r.builderId === builderId) : reviews;
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function addReview(review: Omit<BuilderReview, "id" | "createdAt">): BuilderReview {
  const created: BuilderReview = {
    ...review,
    id: `rev-${reviews.length + 1}-${review.builderId}`,
    createdAt: new Date().toISOString(),
  };
  reviews.push(created);
  return created;
}

/** True when this reviewer already left a review for the builder. */
export function hasReviewed(builderId: string, reviewer: string): boolean {
  return reviews.some((r) => r.builderId === builderId && r.reviewer === reviewer);
}

export function getReviewSummary(builderId: string): {
  averageRating: number;
  reviewCount: number;
} {
  const rows = reviews.filter((r) => r.builderId === builderId);
  if (rows.length === 0) return { averageRating: 0, reviewCount: 0 };
  const total = rows.reduce((sum, r) => sum + r.rating, 0);
  return {
    averageRating: Number((total / rows.length).toFixed(2)),
    reviewCount: rows.length,
  };
}
