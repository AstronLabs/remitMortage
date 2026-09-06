"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";

interface CommentNode {
  id: string;
  loanApplicationId: string;
  authorAddress: string;
  content: string;
  parentId: string | null;
  mentions: string[];
  createdAt: string;
  updatedAt?: string;
  replies: CommentNode[];
}

interface LoanCommentsPanelProps {
  loanApplicationId: string;
  currentUserAddress: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function highlightMentions(content: string): React.ReactNode {
  const parts = content.split(/(@[A-Za-z0-9_.-]+)/g);
  return parts.map((part, i) =>
    part.startsWith("@") ? (
      <span key={i} className="text-sky-400 font-medium">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

export default function LoanCommentsPanel({ loanApplicationId, currentUserAddress }: LoanCommentsPanelProps) {
  const [comments, setComments] = useState<CommentNode[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mentionSuggestions, setMentionSuggestions] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fetchComments = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/loan/${loanApplicationId}/comments`);
      if (!res.ok) return;
      const data = await res.json();
      setComments(data.comments || []);
      setTotal(data.total ?? 0);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [loanApplicationId]);

  // Real-time polling for all reviewers viewing same application
  useEffect(() => {
    fetchComments();
    const interval = setInterval(fetchComments, 3000);
    return () => clearInterval(interval);
  }, [fetchComments]);

  // Mock reviewer list for @-mention suggestions; in production fetch from /api/admin/reviewers
  const reviewers = ["admin", "GBORROWER1", "reviewer2", "alice", "bob"];

  function handleInputChange(value: string) {
    setContent(value);
    const atMatch = value.match(/@([A-Za-z0-9_.-]*)$/);
    if (atMatch) {
      const q = atMatch[1].toLowerCase();
      setMentionSuggestions(reviewers.filter((r) => r.toLowerCase().includes(q)).slice(0, 5));
    } else {
      setMentionSuggestions([]);
    }
  }

  function insertMention(username: string) {
    const newVal = content.replace(/@([A-Za-z0-9_.-]*)$/, `@${username} `);
    setContent(newVal);
    setMentionSuggestions([]);
    textareaRef.current?.focus();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/loan/${loanApplicationId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authorAddress: currentUserAddress,
          content: content.trim(),
          parentId: replyTo,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.message || "Failed to post comment");
        return;
      }
      setContent("");
      setReplyTo(null);
      setMentionSuggestions([]);
      await fetchComments();
    } finally {
      setSubmitting(false);
    }
  }

  function renderThread(nodes: CommentNode[], depth = 0) {
    return nodes.map((node) => (
      <div key={node.id} id={`comment-${node.id}`} className={`${depth > 0 ? "ml-6 border-l border-white/10 pl-4" : ""} py-3`}>
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <span className="font-mono font-medium text-[var(--text-primary)]">{node.authorAddress.slice(0, 8)}…{node.authorAddress.slice(-4)}</span>
          <span>{formatTime(node.createdAt)}</span>
          {node.mentions.length > 0 && (
            <span className="text-sky-400">mentions: {node.mentions.join(", ")}</span>
          )}
        </div>
        <p className="mt-1 text-sm text-[var(--text-secondary)] whitespace-pre-wrap">{highlightMentions(node.content)}</p>
        <div className="mt-2 flex gap-3">
          <button
            onClick={() => setReplyTo(node.id)}
            className="text-xs text-sky-400 hover:underline"
          >
            Reply
          </button>
          <a href={`#comment-${node.id}`} className="text-xs text-[var(--text-muted)] hover:text-white">
            Link
          </a>
        </div>
        {node.replies.length > 0 && <div className="mt-2">{renderThread(node.replies, depth + 1)}</div>}
      </div>
    ));
  }

  return (
    <section aria-label="Loan review comments" className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-lg p-4 mt-6">
      <h3 className="text-sm font-bold mb-1">Review Discussion ({total})</h3>
      <p className="text-xs text-[var(--text-muted)] mb-4">Threaded comments — @-mention reviewers to notify them. Updates live for all viewers.</p>

      {loading ? (
        <p className="text-xs text-[var(--text-muted)]">Loading comments…</p>
      ) : comments.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)] py-6 text-center">No comments yet. Start the discussion.</p>
      ) : (
        <div className="space-y-1 max-h-[400px] overflow-y-auto pr-1 mb-4">{renderThread(comments)}</div>
      )}

      {replyTo && (
        <div className="mb-2 text-xs">
          <span className="text-[var(--text-muted)]">Replying to {replyTo.slice(0, 8)}…</span>
          <button onClick={() => setReplyTo(null)} className="ml-2 text-sky-400 hover:underline">
            Cancel
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="relative">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => handleInputChange(e.target.value)}
          placeholder="Add a comment… use @ to mention a reviewer"
          rows={3}
          className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-sm placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-sky-500"
        />
        {mentionSuggestions.length > 0 && (
          <ul className="absolute z-10 left-0 right-0 mt-1 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg max-h-32 overflow-y-auto">
            {mentionSuggestions.map((u) => (
              <li key={u}>
                <button
                  type="button"
                  onClick={() => insertMention(u)}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-white/5"
                >
                  @{u}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex justify-end">
          <button
            type="submit"
            disabled={submitting || !content.trim()}
            className="px-4 py-1.5 rounded-lg text-sm font-medium bg-sky-500 text-white hover:bg-sky-600 disabled:opacity-40"
          >
            {submitting ? "Posting…" : replyTo ? "Reply" : "Comment"}
          </button>
        </div>
      </form>
    </section>
  );
}
