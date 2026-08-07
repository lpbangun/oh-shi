## What changed

<!-- Describe the user or operator outcome in one or two sentences. -->

Closes <!-- issue number, when applicable -->

## Why it is safe

<!-- Note the invariant, source-policy decision, or compatibility contract this preserves. -->

## Verification

- [ ] `pnpm typecheck`
- [ ] `pnpm eval`
- [ ] `pnpm lint` (when applicable)
- [ ] `pnpm e2e` or `pnpm quality:ci` (when UI or browser behavior changes)

<!-- Add exact commands, results, and before/after screenshots for visible UI changes. -->

## Release impact

<!-- Note public API compatibility, migrations, configuration, deployment steps, or "None". -->

## Checklist

- [ ] Documentation is updated for new public or operational behavior.
- [ ] No secrets, private artifacts, or generated build output are included.
- [ ] New external sources are permitted, attributable, bounded, and fail closed.
- [ ] Public API and data-contract changes are backward compatible or clearly called out.
