## Summary

<!-- What changed and why. Link the issue: Closes #… -->

## Testing

<!-- How was this tested? Commands run, screenshots for UI changes. -->

## Checklist

- [ ] Tests cover the change
- [ ] Tests build loans, applicants and milestones with the shared factories in `backend/src/test-utils/factories` — no inline fixtures for these entities (see `docs/TEST_DATA_FACTORIES.md`)
- [ ] Nothing secret is exposed to the client: new browser-side variables use the `NEXT_PUBLIC_` prefix and hold only public values
- [ ] Docs updated if behaviour or configuration changed
