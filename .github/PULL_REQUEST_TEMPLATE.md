## What changed

<!-- Describe the user or operator outcome in one or two sentences. -->

## Why it is safe

<!-- Note the invariant, source-policy decision, or compatibility contract this preserves. -->

## Verification

- [ ] `pnpm typecheck`
- [ ] `pnpm eval`
- [ ] `pnpm lint` (when applicable)
- [ ] `pnpm e2e` or `pnpm quality:ci` (when UI or browser behavior changes)

## Checklist

- [ ] Documentation is updated for new public or operational behavior.
- [ ] No secrets, private artifacts, or generated build output are included.
- [ ] New external sources are permitted, attributable, bounded, and fail closed.
