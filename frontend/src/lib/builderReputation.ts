// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/** Types and client helpers for the builder reputation / review system. */

export interface BuilderStats {
  id: string;
  name: string;
  /** Whitelisted on the verification registry. */
  whitelisted: boolean;
  projectsCompleted: number;
  projectsTotal: number;
  /** 0-100, sourced from the indexer. */
  completionRate: number;
  /** 0-5 average of submitted borrower reviews. */
  averageRating: number;
  reviewCount: number;
  /** Median days between milestone approval and payout. */
  avgPayoutDays: number;
}

export interface BuilderReview {
  id: string;
  builderId: string;
  reviewer: string;
  rating: number;
  comment: string;
  createdAt: string;
}

export interface ReviewDraft {
  builderId: string;
  rating: number;
  comment: string;
  reviewer: string;
}

export const MIN_COMMENT_LENGTH = 10;
export const MAX_COMMENT_LENGTH = 500;

/** Validates a review draft. Returns an error message, or null when valid. */
export function validateReview(draft: Partial<ReviewDraft>): string | null {
  if (!draft.reviewer) {
    return "Connect your wallet to submit a review.";
  }
  if (!draft.builderId) {
    return "Select a builder to review.";
  }
  if (!draft.rating || draft.rating < 1 || draft.rating > 5) {
    return "Select a rating between 1 and 5 stars.";
  }
  const comment = (draft.comment ?? "").trim();
  if (comment.length < MIN_COMMENT_LENGTH) {
    return `Review must be at least ${MIN_COMMENT_LENGTH} characters.`;
  }
  if (comment.length > MAX_COMMENT_LENGTH) {
    return `Review must be under ${MAX_COMMENT_LENGTH} characters.`;
  }
  return null;
}

/** Renders a 0-5 rating as filled/empty stars. */
export function toStars(rating: number): string {
  const rounded = Math.round(Math.max(0, Math.min(5, rating)));
  return "★".repeat(rounded) + "☆".repeat(5 - rounded);
}

export function formatCompletionRate(rate: number): string {
  return `${Math.round(rate)}%`;
}

export async function fetchBuilders(): Promise<BuilderStats[]> {
  const res = await fetch("/api/builders", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load builder reputation data");
  return res.json();
}

export async function fetchReviews(builderId: string): Promise<BuilderReview[]> {
  const res = await fetch(
    `/api/builders/reviews?builderId=${encodeURIComponent(builderId)}`,
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error("Failed to load reviews");
  return res.json();
}

export async function submitReview(draft: ReviewDraft): Promise<BuilderReview> {
  const res = await fetch("/api/builders/reviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to submit review");
  }
  return res.json();
}
