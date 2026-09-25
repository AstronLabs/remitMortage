"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useState } from "react";
import { useWallet } from "@/context/WalletContext";
import {
  fetchBuilders,
  fetchReviews,
  formatCompletionRate,
  toStars,
  type BuilderReview,
  type BuilderStats,
} from "@/lib/builderReputation";
import ReviewSubmissionForm from "./ReviewSubmissionForm";

/**
 * Builder reputation table for the Contractor Portal: completion metrics pulled
 * from the indexer API, star ratings aggregated from borrower reviews, and an
 * inline review form for the selected builder.
 */
export default function BuilderReputationTable() {
  const { publicKey, isConnected } = useWallet();
  const [builders, setBuilders] = useState<BuilderStats[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviews, setReviews] = useState<BuilderReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadBuilders = useCallback(async () => {
    try {
      setError(null);
      setBuilders(await fetchBuilders());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load builders");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBuilders();
  }, [loadBuilders]);

  const loadReviews = useCallback(async (builderId: string) => {
    try {
      setReviews(await fetchReviews(builderId));
    } catch {
      setReviews([]);
    }
  }, []);

  const selectBuilder = (builderId: string) => {
    const next = selectedId === builderId ? null : builderId;
    setSelectedId(next);
    if (next) void loadReviews(next);
    else setReviews([]);
  };

  const onReviewSubmitted = async () => {
    await loadBuilders();
    if (selectedId) await loadReviews(selectedId);
  };

  const selected = builders.find((b) => b.id === selectedId) ?? null;

  return (
    <section className="mt-12" aria-labelledby="builder-reputation-heading">
      <h2
        id="builder-reputation-heading"
        className="text-xl font-bold text-white mb-1"
      >
        Builder Reputation
      </h2>
      <p className="text-slate-400 text-sm mb-5">
        Completion statistics are sourced live from the indexer; ratings are
        submitted by verified borrowers.
      </p>

      {loading && <p className="text-slate-400 text-sm">Loading builders…</p>}

      {error && (
        <p role="alert" className="text-red-400 text-sm">
          {error}
        </p>
      )}

      {!loading && !error && (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-900/70 text-slate-400 uppercase text-xs tracking-wider">
              <tr>
                <th scope="col" className="px-4 py-3">Builder</th>
                <th scope="col" className="px-4 py-3">Rating</th>
                <th scope="col" className="px-4 py-3">Completion</th>
                <th scope="col" className="px-4 py-3">Projects</th>
                <th scope="col" className="px-4 py-3">Avg. Payout</th>
                <th scope="col" className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {builders.map((builder) => (
                <tr key={builder.id} className="hover:bg-slate-900/40">
                  <td className="px-4 py-3">
                    <span className="font-semibold text-white">{builder.name}</span>
                    {builder.whitelisted && (
                      <span className="ml-2 px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 text-[10px] font-semibold uppercase border border-cyan-500/20">
                        Whitelisted
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className="text-amber-400"
                      aria-label={`${builder.averageRating} out of 5 stars`}
                    >
                      {toStars(builder.averageRating)}
                    </span>
                    <span className="ml-2 text-slate-400 text-xs">
                      {builder.averageRating.toFixed(1)} ({builder.reviewCount})
                    </span>
                  </td>
                  <td className="px-4 py-3 text-emerald-400 font-semibold">
                    {formatCompletionRate(builder.completionRate)}
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {builder.projectsCompleted}/{builder.projectsTotal}
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {builder.avgPayoutDays}d
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => selectBuilder(builder.id)}
                      className="text-cyan-400 hover:text-cyan-300 text-xs font-semibold"
                    >
                      {selectedId === builder.id ? "Hide" : "Reviews"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="mt-6 rounded-xl border border-slate-800 p-5">
          <h3 className="text-white font-semibold mb-3">
            Reviews for {selected.name}
          </h3>

          {reviews.length === 0 ? (
            <p className="text-slate-400 text-sm">No reviews yet.</p>
          ) : (
            <ul className="space-y-3">
              {reviews.map((review) => (
                <li key={review.id} className="border-b border-slate-800 pb-3">
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span className="text-amber-400">{toStars(review.rating)}</span>
                    <span className="font-mono">{review.reviewer}</span>
                    <span>{new Date(review.createdAt).toLocaleDateString()}</span>
                  </div>
                  <p className="text-slate-300 text-sm mt-1">{review.comment}</p>
                </li>
              ))}
            </ul>
          )}

          <ReviewSubmissionForm
            builderId={selected.id}
            builderName={selected.name}
            reviewer={publicKey}
            isAuthenticated={isConnected && !!publicKey}
            onSubmitted={onReviewSubmitted}
          />
        </div>
      )}
    </section>
  );
}
