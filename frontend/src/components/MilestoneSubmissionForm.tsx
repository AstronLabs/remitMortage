"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import { useFormAutosave } from "@/hooks/useFormAutosave";

export interface CostItem {
  label: string;
  amount: string;
}

/**
 * Structured milestone evidence submission. Binary uploads are handled
 * separately by {@link EvidenceUpload}; this form captures the descriptive
 * fields — work description, cost breakdown and evidence metadata — and
 * autosaves them so a connectivity drop or accidental navigation doesn't lose
 * progress.
 */
export interface MilestoneSubmission {
  description: string;
  costItems: CostItem[];
  evidenceType: string;
  evidenceNotes: string;
}

export const EVIDENCE_TYPES = ["photo", "video", "invoice", "inspection-report"] as const;

export const emptyMilestoneSubmission = (): MilestoneSubmission => ({
  description: "",
  costItems: [],
  // Left blank until the contractor picks one so an untouched form counts as
  // having no data and is never autosaved.
  evidenceType: "",
  evidenceNotes: "",
});

/** localStorage key for a milestone's in-progress draft. */
export const milestoneDraftKey = (milestoneId: string): string =>
  `milestone-submission-draft:${milestoneId}`;

interface MilestoneSubmissionFormProps {
  milestoneId: string;
  onSubmit: (submission: MilestoneSubmission) => void | Promise<void>;
  disabled?: boolean;
  /** Extra classes for the wrapping form. */
  className?: string;
}

export default function MilestoneSubmissionForm({
  milestoneId,
  onSubmit,
  disabled = false,
  className = "",
}: MilestoneSubmissionFormProps) {
  const [form, setForm] = useState<MilestoneSubmission>(emptyMilestoneSubmission);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { hasDraft, draftRestored, restoreDraft, clearDraft, dismissDraft } = useFormAutosave(
    form,
    { key: milestoneDraftKey(milestoneId) }
  );

  const update = (patch: Partial<MilestoneSubmission>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  const handleResume = () => {
    const draft = restoreDraft();
    if (!draft) return;
    const restored = draft as MilestoneSubmission;
    setForm({
      description: restored.description ?? "",
      costItems: restored.costItems ?? [],
      evidenceType: restored.evidenceType ?? "",
      evidenceNotes: restored.evidenceNotes ?? "",
    });
  };

  const handleDiscard = () => {
    clearDraft();
    setForm(emptyMilestoneSubmission());
    setSubmitError(null);
  };

  const addCostItem = () =>
    setForm((prev) => ({
      ...prev,
      costItems: [...prev.costItems, { label: "", amount: "" }],
    }));

  const updateCostItem = (index: number, patch: Partial<CostItem>) =>
    setForm((prev) => ({
      ...prev,
      costItems: prev.costItems.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    }));

  const removeCostItem = (index: number) =>
    setForm((prev) => ({
      ...prev,
      costItems: prev.costItems.filter((_, i) => i !== index),
    }));

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || isSubmitting) return;
    if (form.description.trim().length === 0) {
      setSubmitError("Describe the work completed before submitting.");
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit({
        ...form,
        // Normalise an unset evidence type to the default before handing off.
        evidenceType: form.evidenceType || "photo",
      });
      // The milestone is now submitted — drop the draft and reset the fields so
      // the pending autosave debounce can't re-create it.
      clearDraft();
      setForm(emptyMilestoneSubmission());
    } catch {
      setSubmitError("Could not submit the milestone. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={`mt-4 p-4 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-md space-y-4 ${className}`}
      data-testid="milestone-submission-form"
    >
      {hasDraft && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 p-3 rounded-md bg-amber-500/10 border border-amber-500/30 text-sm text-amber-400"
        >
          <span>You have an unsaved draft for this milestone.</span>
          <button type="button" onClick={handleResume} className="font-semibold underline">
            Resume draft
          </button>
          <button type="button" onClick={handleDiscard} className="font-semibold underline">
            Discard
          </button>
        </div>
      )}

      {draftRestored && (
        <p role="status" className="text-xs text-[var(--text-muted)]">
          Draft restored.
        </p>
      )}

      <div>
        <label
          htmlFor={`milestone-description-${milestoneId}`}
          className="block text-sm font-semibold mb-1"
        >
          Work completed
        </label>
        <textarea
          id={`milestone-description-${milestoneId}`}
          value={form.description}
          onChange={(e) => update({ description: e.target.value })}
          rows={3}
          disabled={disabled || isSubmitting}
          placeholder="Describe the milestone work completed and how it was verified."
          className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] p-2 text-sm"
        />
      </div>

      <fieldset>
        <legend className="text-sm font-semibold mb-1">Cost breakdown</legend>
        {form.costItems.length === 0 && (
          <p className="text-xs text-[var(--text-muted)] mb-2">No cost items added yet.</p>
        )}
        {form.costItems.map((item, index) => (
          <div key={index} className="flex gap-2 mb-2">
            <label className="sr-only" htmlFor={`cost-label-${milestoneId}-${index}`}>
              Cost item {index + 1} description
            </label>
            <input
              id={`cost-label-${milestoneId}-${index}`}
              value={item.label}
              onChange={(e) => updateCostItem(index, { label: e.target.value })}
              placeholder="Item"
              disabled={disabled || isSubmitting}
              className="flex-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] p-2 text-sm"
            />
            <label className="sr-only" htmlFor={`cost-amount-${milestoneId}-${index}`}>
              Cost item {index + 1} amount
            </label>
            <input
              id={`cost-amount-${milestoneId}-${index}`}
              value={item.amount}
              onChange={(e) => updateCostItem(index, { amount: e.target.value })}
              placeholder="Amount"
              inputMode="decimal"
              disabled={disabled || isSubmitting}
              className="w-28 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] p-2 text-sm"
            />
            <button
              type="button"
              onClick={() => removeCostItem(index)}
              disabled={disabled || isSubmitting}
              aria-label={`Remove cost item ${index + 1}`}
              className="px-3 rounded-md border border-[var(--border-color)] text-sm"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addCostItem}
          disabled={disabled || isSubmitting}
          className="text-sm font-semibold underline"
        >
          Add cost item
        </button>
      </fieldset>

      <div className="flex gap-3">
        <div className="flex-1">
          <label
            htmlFor={`evidence-type-${milestoneId}`}
            className="block text-sm font-semibold mb-1"
          >
            Evidence type
          </label>
          <select
            id={`evidence-type-${milestoneId}`}
            value={form.evidenceType}
            onChange={(e) => update({ evidenceType: e.target.value })}
            disabled={disabled || isSubmitting}
            className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] p-2 text-sm"
          >
            <option value="">Select…</option>
            {EVIDENCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label
            htmlFor={`evidence-notes-${milestoneId}`}
            className="block text-sm font-semibold mb-1"
          >
            Evidence notes
          </label>
          <input
            id={`evidence-notes-${milestoneId}`}
            value={form.evidenceNotes}
            onChange={(e) => update({ evidenceNotes: e.target.value })}
            disabled={disabled || isSubmitting}
            placeholder="Reference, inspector, date…"
            className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] p-2 text-sm"
          />
        </div>
      </div>

      {submitError && (
        <p role="alert" className="text-sm text-red-500">
          {submitError}
        </p>
      )}

      <button
        type="submit"
        disabled={disabled || isSubmitting}
        className="w-full py-2 rounded-full font-bold bg-[var(--accent-primary)] text-white disabled:opacity-50"
      >
        {isSubmitting ? "Submitting…" : "Save milestone submission"}
      </button>
    </form>
  );
}
