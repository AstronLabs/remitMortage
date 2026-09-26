# Keyboard Accessibility

Every core flow must be completable with the keyboard alone. This page records
the audit of the current flows and the checklist to run on any new flow.

## Automated checks

`frontend/__tests__/KeyboardNavigation.a11y.test.tsx` drives each core flow with
Tab, Shift+Tab, Enter, Escape and the arrow keys, and runs the axe-core focus
and tab order rules (`tabindex`, `focus-order-semantics`, `aria-hidden-focus`,
`nested-interactive`, `scrollable-region-focusable`, plus naming and role rules
for the controls involved). It runs in CI as the "Keyboard Accessibility Checks"
step of the frontend job.

```bash
cd frontend
npm run test:a11y
```

When you add a flow, add a test there that completes it with the keyboard.

## Audit (issue #696)

| Flow | Blocking issue found | Fix |
| --- | --- | --- |
| All flows | Several controls remove the browser outline (`outline-none`, `outline: none`), so keyboard focus was invisible or very faint on the dark theme. | Global `:focus-visible` outline in `globals.css`, unlayered so utilities cannot remove it. |
| Loan application (`/application`) | No blocking issues. Tab order is amount, then submit, and the result is announced through `role="status"`. | None beyond the global focus outline. |
| Milestone approval (`/admin`) | Section tabs were plain buttons: no tab semantics, no arrow key support, every tab in the Tab order. | Proper `tablist` / `tab` / `tabpanel` roles, roving `tabIndex`, Left/Right/Home/End keys. |
| Milestone approval (`/admin`) | The confirm dialog did not move focus into itself, let Tab escape to the page behind, ignored Escape, and dropped focus on close. | `useFocusTrap`: focus moves in, Tab and Shift+Tab wrap, Escape cancels, focus returns to the Approve button. |
| Investor deposit (`/invest`) | Tranche radio inputs are visually hidden, so the selected card showed no focus. The group label was a `<label>` tied to nothing. | `fieldset` and `legend`, plus a focus ring on the card while its radio has focus. Arrow keys switch tranche. |
| Investor deposit (`/invest`) | The auto reinvest dialog had no focus trap, no Escape, and no focus return. | `useFocusTrap`. |
| Investor deposit (`/invest`) | Deposit errors and success messages were not announced. | `role="alert"` and `role="status"`. |
| Escrow deposit dialog (dashboard) | Same dialog issues as above, and focus did not start on the amount field. The nested transaction status dialog had no trap. | `useFocusTrap` on both. Only the innermost open dialog handles Tab and Escape, and the status dialog only closes on Escape once the transaction has finished. |

## Manual checklist for new flows

Run this with the mouse unplugged (or untouched) before merging a new flow.

1. Start from the address bar and press Tab. The skip link appears first, then the page controls in reading order.
2. Every focused element shows a clearly visible outline or ring. Check both light and dark themes.
3. Nothing receives focus that is hidden, disabled, or purely decorative. No positive `tabIndex` values.
4. Every action works with Enter (buttons, links) or Space (buttons, checkboxes). Custom controls built from `div` or `span` are not used where a native element fits.
5. Radio groups, tabs, and menus move with the arrow keys, and only the active item is in the Tab order.
6. Opening a dialog moves focus into it. Tab and Shift+Tab stay inside the dialog. Escape closes it unless closing would abandon an action in progress.
7. Closing a dialog returns focus to the control that opened it.
8. Errors and results are announced (`role="alert"` or `role="status"`) and focus is not lost when content changes.
9. The flow can be completed start to finish without the mouse.
10. Add or extend a test in `KeyboardNavigation.a11y.test.tsx` that covers the flow.

For dialogs, use `useFocusTrap` from `frontend/src/hooks/useFocusTrap.ts` instead
of writing a new trap:

```tsx
const dialogRef = useRef<HTMLDivElement>(null);
useFocusTrap(dialogRef, isOpen, { onEscape: onClose });

return (
  <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="title">
    ...
  </div>
);
```
