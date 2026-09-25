"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import {
  MAX_COMMENT_LENGTH,
  submitReview,
  validateReview,
} from "@/lib/builderReputation";

interface Props {
  builderId: string;
  builderName: string;
  /** Connected borrower address, or null when unauthenticated. */
  reviewer: string | null;
  isAuthenticated: boolean;
  onSubmitted?: () => void | Promise<void>;
}

const RATINGS = [1, 2, 3, 4, 5];

/**
 * Review submission form. Borrower authentication is checked before the request
 * is made; the API re-checks it server-side.
 */
export default function ReviewSubmissionForm({
  builderId,
  builderName,
  reviewer,
  isAuthenticated,
  onSubmitted,
}: Props) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!isAuthenticated || !reviewer) {
    return (
      <p className="mt-5 text-sm text-amber-400" role="status">
        Connect your borrower wallet to review {builderName}.
      </p>
    );
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(false);

    const draft = { builderId, reviewer, rating, comment: comment.trim() };
    const validationError = validateReview(draft);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      await submitReview(draft);
      setSuccess(true);
      setRating(0);
      setComment("");
      await onSubmitted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit review");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mt-5 space-y-3">
      <fieldset className="flex items-center gap-2">
        <legend className="text-sm text-slate-300 mb-1">Your rating</legend>
        {RATINGS.map((value) => (
          <button
            key={value}
            type="button"
            aria-label={`${value} star${value > 1 ? "s" : ""}`}
            aria-pressed={rating === value}
            onClick={() => setRating(value)}
            className={`text-2xl leading-none ${
              value <= rating ? "text-amber-400" : "text-slate-600"
            }`}
          >
            ★
          </button>
        ))}
      </fieldset>

      <label className="block">
        <span className="text-sm text-slate-300">Your review</span>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={MAX_COMMENT_LENGTH}
          rows={3}
          placeholder={`Describe your experience working with ${builderName}`}
          className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100"
        />
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="text-sm text-emerald-400">
          Review submitted.
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 rounded-lg bg-cyan-500 text-slate-950 text-sm font-semibold disabled:opacity-50"
      >
        {submitting ? "Submitting…" : "Submit review"}
      </button>
    </form>
  );
}
