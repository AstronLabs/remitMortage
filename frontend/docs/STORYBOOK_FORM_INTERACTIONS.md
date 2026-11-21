# Adding Storybook Stories & Form Interaction Tests

Form components under `frontend/src/components/forms/` are paired with Storybook stories (`*.stories.tsx`) and Jest interaction tests (`frontend/src/components/forms/__tests__/FormStoriesInteraction.test.tsx`) so typing, validation error states, keyboard navigation, and disabled states are verified on every `npm test` run.

## Required Stories per Form Component

Every form control story file should export at least three baseline stories:

1. **`Default`**: Interactive stateful wrapper exercising live user input and validation recovery.
2. **`WithErrorState`**: Renders the control with an active validation error (`aria-invalid="true"`, `aria-describedby`, and `role="alert"` message).
3. **`Disabled`**: Renders the control with `disabled={true}` so keyboard and pointer edits are blocked.

## Adding an Interaction Test

1. Create `src/components/forms/<ComponentName>.stories.tsx` with `Meta<typeof ComponentName>` under `title: "Shared/Forms/<ComponentName>"`.
2. Import the component and its story module in `src/components/forms/__tests__/FormStoriesInteraction.test.tsx`.
3. Use `@testing-library/user-event` (`userEvent.setup()`) to drive real keyboard interactions (`await user.tab()`, `await user.type(...)`, `await user.selectOptions(...)`) and assert:
   - Focus lands on the expected control via `Tab`.
   - Invalid input announces an alert (`screen.getByRole("alert")`) and sets `aria-invalid="true"`.
   - Valid input clears the alert and emits the parsed value.
   - `disabled` prevents `onChange` / `onFileSelect` from firing.
4. Run the suite with the standard frontend test command:
   ```bash
   cd frontend && npm test
   ```
