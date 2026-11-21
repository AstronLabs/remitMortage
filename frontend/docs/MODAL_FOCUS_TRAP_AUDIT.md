# Modal and Drawer Focus Trap Audit

This document lists every modal, dialog, and drawer component in the frontend and verifies its keyboard focus trap, background inertness, Escape handling, and focus restoration behavior.

## Shared Hook: `useFocusTrap`

All modals and drawers use `useFocusTrap(containerRef, isOpen, { onEscape, initialFocusRef })` from `src/hooks/useFocusTrap.ts`, which guarantees:

1. **Initial Focus**: Moves focus into the dialog when opened (`initialFocusRef` or the first focusable control, falling back to the `tabIndex={-1}` dialog container).
2. **Tab / Shift+Tab Wrapping**: Loops focus strictly across focusable controls inside the active innermost dialog.
3. **Background Inertness**: Marks sibling trees outside the active modal path with `inert` and `aria-hidden="true"` while open, and restores their original attributes on close.
4. **Escape Handling**: Invokes `onEscape` for the innermost open trap.
5. **Focus Restoration**: Returns focus to the trigger element (`document.activeElement` at open time) when the dialog closes.

## Audited Modals and Drawers

| Component | Path | Role & ARIA | Focus Trap & Escape |
| --- | --- | --- | --- |
| `ConfirmationDialog` | `src/components/ConfirmationDialog.tsx` | `role="alertdialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: handleCancel` |
| `BulkActionReviewDialog` | `src/components/BulkActionReviewDialog.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: handleCancel` |
| `UnsavedChangesDialog` | `src/components/UnsavedChangesDialog.tsx` | `role="alertdialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: onStay` |
| `TransactionModal` | `src/components/tx/TransactionModal.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: onClose` |
| `DepositModal` | `src/components/DepositModal.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: onClose`, `initialFocusRef: amountInputRef` |
| `WithdrawModal` | `src/components/WithdrawModal.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: onClose` |
| `AutoReinvestModal` | `src/components/AutoReinvestModal.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: onClose` |
| `ReportProblemDialog` | `src/components/support/ReportProblemDialog.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: onClose` |
| `WalletSelectModal` | `src/components/WalletSelectModal.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: onClose` |
| `MultiWalletModal` | `src/components/MultiWalletModal.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: onClose` |
| `NotificationDrawer` | `src/components/NotificationDrawer.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: closePanel` |
| `EvidenceModal` | `src/components/EvidenceModal.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: onClose` |
| `IdleSessionModal` | `src/components/IdleSessionModal.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: onExtendSession` |
| `KeyboardShortcutsModal` | `src/components/KeyboardShortcutsModal.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: onClose` |
| `WidgetSettingsModal` | `src/components/dashboard/WidgetSettingsModal.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: onClose` |
| `EvidenceDrawer` | `src/components/governance/EvidenceDrawer.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: onClose` |
| `GovernanceVotingModal` | `src/components/governance/GovernanceVotingModal.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape: onClose` |
| `SubmitProposalModal` | `src/components/governance/SubmitProposalModal.tsx` | `role="dialog"`, `aria-modal="true"` | `useFocusTrap` with `onEscape` when not submitting |
