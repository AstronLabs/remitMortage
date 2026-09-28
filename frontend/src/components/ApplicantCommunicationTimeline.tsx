"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useCallback, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Search, Mail, MessageSquare, Bell, MessagesSquare } from "lucide-react";
import {
  ApplicantCommunicationTimeline as TimelineData,
  CommunicationChannel,
  fetchApplicantCommunicationTimeline,
} from "../lib/communicationTimelineApi";
import { EmptyState } from "./EmptyState";

const CHANNEL_LABEL: Record<CommunicationChannel, string> = {
  EMAIL: "Email",
  SMS: "SMS",
  IN_APP: "In-App",
};

const CHANNEL_ICON: Record<CommunicationChannel, React.ReactNode> = {
  EMAIL: <Mail className="h-3.5 w-3.5" aria-hidden="true" />,
  SMS: <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />,
  IN_APP: <Bell className="h-3.5 w-3.5" aria-hidden="true" />,
};

function statusBadgeClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "sent" || normalized === "read") {
    return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
  }
  if (normalized === "failed") {
    return "bg-red-500/10 text-red-400 border-red-500/30";
  }
  return "bg-amber-500/10 text-amber-400 border-amber-500/30"; // Pending / Unread
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const CHANNEL_FILTERS: Array<CommunicationChannel | "ALL"> = ["ALL", "EMAIL", "SMS", "IN_APP"];

export default function ApplicantCommunicationTimeline({ adminToken }: { adminToken?: string }) {
  const [query, setQuery] = useState("");
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channelFilter, setChannelFilter] = useState<CommunicationChannel | "ALL">("ALL");

  const loadTimeline = useCallback(
    async (identifier: string) => {
      const trimmed = identifier.trim();
      if (!trimmed) return;

      setLoading(true);
      setError(null);
      try {
        const data = await fetchApplicantCommunicationTimeline(trimmed, adminToken);
        setTimeline(data);
      } catch (err) {
        setTimeline(null);
        const message = err instanceof Error ? err.message : "Failed to load communication timeline";
        setError(message);
        toast.error(message);
      } finally {
        setLoading(false);
      }
    },
    [adminToken]
  );

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    loadTimeline(query);
  }

  const visibleEntries = useMemo(() => {
    if (!timeline) return [];
    if (channelFilter === "ALL") return timeline.entries;
    return timeline.entries.filter((entry) => entry.channel === channelFilter);
  }, [timeline, channelFilter]);

  return (
    <div className="space-y-6">
      {/* Applicant lookup */}
      <form onSubmit={handleSubmit} className="p-4 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)]">
        <div className="flex items-center gap-2 mb-3">
          <MessagesSquare className="h-4 w-4 text-[var(--text-muted)]" />
          <h3 className="text-sm font-semibold">Applicant Communication Timeline</h3>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-muted)]" />
          <input
            type="text"
            placeholder="Applicant id or stellar address..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
          />
        </div>
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="mt-3 px-4 py-2 text-sm font-medium rounded-lg bg-[var(--accent-primary)] text-white hover:opacity-90 transition-colors disabled:opacity-50"
        >
          {loading ? "Loading..." : "Load timeline"}
        </button>
      </form>

      {error && (
        <div className="p-4 rounded-lg border border-red-500/40 bg-red-500/10 text-sm text-red-400">
          {error}
        </div>
      )}

      {timeline && (
        <>
          {/* Applicant summary + channel filters */}
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
            <div className="space-x-4">
              <span>
                <strong className="text-[var(--text-primary)]">Address:</strong>{" "}
                {timeline.stellarAddress}
              </span>
              <span>
                <strong className="text-[var(--text-primary)]">Email:</strong>{" "}
                {timeline.email ?? "—"}
              </span>
              <span>
                <strong className="text-[var(--text-primary)]">Phone:</strong>{" "}
                {timeline.phone ?? "—"}
              </span>
            </div>
            <div className="flex gap-1.5">
              {CHANNEL_FILTERS.map((channel) => (
                <button
                  key={channel}
                  type="button"
                  onClick={() => setChannelFilter(channel)}
                  className={`px-2.5 py-1 rounded-full border text-xs transition-colors ${
                    channelFilter === channel
                      ? "bg-[var(--accent-primary)] text-white border-[var(--accent-primary)]"
                      : "border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-card)]"
                  }`}
                >
                  {channel === "ALL" ? "All" : CHANNEL_LABEL[channel]}
                </button>
              ))}
            </div>
          </div>

          {visibleEntries.length === 0 ? (
            <EmptyState
              icon={<MessagesSquare className="h-5 w-5" />}
              title="No communications found"
              message="This applicant has no recorded email, SMS, or in-app notifications for the selected channel."
            />
          ) : (
            <ol className="space-y-2">
              {visibleEntries.map((entry) => (
                <li
                  key={`${entry.channel}-${entry.id}`}
                  className="flex items-start gap-3 p-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)]"
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                    {CHANNEL_ICON[entry.channel]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-[var(--text-primary)]">
                        {CHANNEL_LABEL[entry.channel]}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wide ${statusBadgeClass(entry.status)}`}
                      >
                        {entry.status}
                      </span>
                      <span className="text-[10px] text-[var(--text-muted)]">
                        {formatTimestamp(entry.occurredAt)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-[var(--text-secondary)] break-words">{entry.summary}</p>
                    {entry.lastError && (
                      <p className="mt-1 text-xs text-red-400">Last error: {entry.lastError}</p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {!timeline && !loading && !error && (
        <EmptyState
          icon={<MessagesSquare className="h-5 w-5" />}
          title="Look up an applicant"
          message="Enter an applicant id or stellar address to see every email, SMS, and in-app notification sent to them."
        />
      )}
    </div>
  );
}
