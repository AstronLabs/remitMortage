"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import { BellRing, Check, CheckCheck, X, Trash2, CheckCircle2, AlertCircle, Info, AlertTriangle } from "lucide-react";
import { useNotifications, ToastVariant } from "@/context/NotificationContext";
import { EmptyState } from "@/components/EmptyState";

function formatRelativeTime(createdAt: number) {
  const diffMs = Date.now() - createdAt;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  return new Date(createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function VariantIcon({ variant }: { variant: ToastVariant }) {
  switch (variant) {
    case "success":
      return <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />;
    case "warning":
      return <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />;
    case "error":
      return <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />;
    case "info":
    default:
      return <Info className="h-4 w-4 text-cyan-400 shrink-0" />;
  }
}

export function NotificationDrawer() {
  const {
    notificationHistory,
    unreadCount,
    isPanelOpen,
    closePanel,
    clearHistory,
    markRead,
    markAllRead,
  } = useNotifications();

  const [activeTab, setActiveTab] = useState<"all" | "unread">("all");

  // Display items in reverse-chronological order (newest first)
  const itemsInOrder = [...notificationHistory].reverse();

  const filteredItems = itemsInOrder.filter((item) => {
    if (activeTab === "unread") return !item.read;
    return true;
  });

  return (
    <>
      {isPanelOpen && (
        <button
          type="button"
          aria-label="Close notifications overlay"
          onClick={closePanel}
          className="fixed inset-0 z-[950] bg-black/60 backdrop-blur-[2px] animate-fadeIn"
        />
      )}

      <aside
        aria-label="Notifications panel"
        aria-hidden={!isPanelOpen}
        data-testid="notification-center-drawer"
        className={`fixed end-0 top-0 z-[960] h-full w-full max-w-[24rem] border-s border-slate-800 bg-[#0b1020]/95 shadow-2xl shadow-black/70 backdrop-blur-xl transition-transform duration-300 ease-out ${
          isPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="flex items-start justify-between gap-4 border-b border-slate-800/80 px-5 pb-4 pt-6">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">
                <BellRing className="h-3.5 w-3.5" />
                Notification Inbox
              </div>
              <h2 className="mt-3 text-xl font-bold text-white">Notifications</h2>
              <p className="mt-1 text-xs text-slate-400">
                {unreadCount > 0
                  ? `${unreadCount} unread alert${unreadCount > 1 ? "s" : ""}`
                  : "All caught up! No unread notifications."}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close notifications panel"
              onClick={closePanel}
              className="rounded-lg border border-slate-700 p-2 text-slate-300 transition-colors hover:border-slate-500 hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Filter Tabs & Quick Actions */}
          <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-3 bg-slate-950/40">
            {/* Tabs */}
            <div className="flex items-center gap-1 bg-slate-900/80 p-1 rounded-lg border border-slate-800">
              <button
                type="button"
                onClick={() => setActiveTab("all")}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                  activeTab === "all"
                    ? "bg-cyan-500 text-slate-950 shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                All ({notificationHistory.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("unread")}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                  activeTab === "unread"
                    ? "bg-cyan-500 text-slate-950 shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Unread ({unreadCount})
              </button>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1.5">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  data-testid="mark-all-read-btn"
                  title="Mark all as read"
                  className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1.5 text-xs font-semibold text-cyan-200 transition-colors hover:bg-cyan-500/20 cursor-pointer"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                  Read all
                </button>
              )}
              <button
                type="button"
                onClick={clearHistory}
                title="Clear notification list"
                className="rounded-lg border border-slate-800 p-1.5 text-slate-400 transition-colors hover:border-rose-500/40 hover:text-rose-300 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* List Feed */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {filteredItems.length === 0 ? (
              <EmptyState
                className="h-full"
                icon={<BellRing className="h-5 w-5" />}
                title={activeTab === "unread" ? "No unread notifications" : "No notifications yet"}
                message={
                  activeTab === "unread"
                    ? "You've read all your notifications!"
                    : "Contract activity, escrow deposits, and loan events will appear here."
                }
                action={
                  activeTab === "unread"
                    ? undefined
                    : { label: "Go to dashboard", href: "/dashboard" }
                }
              />
            ) : (
              filteredItems.map((item) => (
                <article
                  key={item.id}
                  data-testid={`notification-item-${item.id}`}
                  className={`relative rounded-xl border p-4 transition-all ${
                    item.read
                      ? "border-slate-800/80 bg-slate-950/40 opacity-75"
                      : "border-cyan-400/40 bg-gradient-to-r from-cyan-950/30 to-slate-900 shadow-md shadow-cyan-950/20"
                  }`}
                >
                  {/* Unread indicator dot */}
                  {!item.read && (
                    <span className="absolute top-3 end-3 h-2 w-2 rounded-full bg-cyan-400 animate-ping" />
                  )}

                  <div className="flex items-start gap-3">
                    <VariantIcon variant={item.variant} />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center justify-between gap-2 pe-4">
                        <p
                          className={`text-xs font-semibold ${
                            item.read ? "text-slate-300" : "text-white font-bold"
                          }`}
                        >
                          {item.title}
                        </p>
                      </div>

                      {item.message && (
                        <p className="text-xs leading-relaxed text-slate-400 leading-snug">
                          {item.message}
                        </p>
                      )}

                      <div className="pt-2 flex items-center justify-between text-[11px] text-slate-500">
                        <span className="font-mono">{formatRelativeTime(item.createdAt)}</span>

                        <div className="flex items-center gap-2">
                          {!item.read && (
                            <button
                              type="button"
                              onClick={() => markRead(item.id)}
                              data-testid={`mark-read-btn-${item.id}`}
                              className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300 font-semibold cursor-pointer"
                            >
                              <Check className="h-3 w-3" />
                              Mark read
                            </button>
                          )}
                          <span
                            className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                              item.read
                                ? "bg-slate-800/80 text-slate-400"
                                : "bg-cyan-400/20 text-cyan-300 border border-cyan-400/30"
                            }`}
                          >
                            {item.read ? "Read" : "New"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

export default NotificationDrawer;
