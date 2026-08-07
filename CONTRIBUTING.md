# Contributing to OH SHI

Thanks for taking an interest in OH SHI. The project is intentionally easy to
inspect: the public UI, public API, ingestion workers, score methodology, and
source-rights decisions live in this repository.

## Before you start

Please read:

- [`README.md`](README.md) for the product and local setup;
- [`docs/architecture.md`](docs/architecture.md) for the backend data flow; and
- [`docs/discovery-sources.md`](docs/discovery-sources.md) before changing
  discovery, source access, or evidence handling.

For substantial features, new public interfaces, or new external sources,
open an issue before investing in an implementation. Bug fixes, tests, and
documentation improvements can usually go straight to a pull request.

## Local development

Use Node.js 22.13 or newer and pnpm 11.17.0 or newer. The version in
[`.nvmrc`](.nvmrc) matches the CI runtime.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://localhost:3000>. Normal UI and public API development requires no
secret or production data. The local runtime creates a D1-compatible database
and seeds a small inspectable data set.

Create a focused branch from an up-to-date default branch:

```bash
git switch -c <type>/<short-description>
```

Common prefixes are `fix/`, `feat/`, `docs/`, and `test/`. The prefix is a
convenience rather than a merge requirement.

## Choose the right check

Run the smallest relevant check while iterating:

| Change | Minimum useful check |
| --- | --- |
| TypeScript or data logic | `pnpm typecheck && pnpm eval` |
| Styles or UI behavior | `pnpm lint && pnpm e2e` |
| Public API or agent contract | `pnpm eval` and the relevant Playwright spec |
| Documentation only | Check links, commands, and rendered Markdown |
| Dependency update | `pnpm quality:ci` and `pnpm audit --prod --audit-level high` |

Before opening a pull request, install Chromium once if needed and run the full
gate:

```bash
pnpm e2e:install
pnpm quality:ci
```

`pnpm quality` runs typecheck, deterministic evaluations, and the production
build. `pnpm quality:ci` also runs lint, Playwright browser coverage, and the
accessibility/usability checks.

## Pull requests

Keep a change focused and explain the user or operator outcome in the PR body.
For changes that affect data behavior, include the invariant that should remain
true and the test that protects it.

- Link the issue when one exists.
- Include before/after screenshots for visible UI changes.
- Call out migrations, new configuration, and operational follow-up explicitly.
- Avoid drive-by formatting or dependency changes in an unrelated pull request.
- Expect CI to pass before review; a maintainer may ask for a narrower test or
  source-rights receipt.

Use this checklist when it applies:

- [ ] The README or a nearby doc explains a new public or operational behavior.
- [ ] Deterministic evaluations cover new normalization, identity, scoring, or
      ingestion rules.
- [ ] API changes preserve existing fields and document new filters or views.
- [ ] UI changes work at desktop width and 320px mobile width, with keyboard
      access and reduced-motion behavior intact.
- [ ] New external sources are permitted, attributed, bounded, and fail closed
      when the response is incomplete.
- [ ] No secrets, generated build output, private review artifacts, or ignored
      local data are committed.

## Data and source policy

OH SHI publishes concise factual fields and links to canonical evidence. A
portfolio page is discovery evidence, not proof of an open role. A job becomes a
verified opening only after a complete current employer-controlled ATS or
first-party structured-career response passes the adapter's eligibility rules.

Do not add a scraper, source, or adapter that bypasses robots rules, terms,
authentication, anti-bot controls, or rate limits. Use the manual import path
for licensed or permission-gated sources and record the rights evidence with the
import.

## Documentation and preview assets

If a UI change materially alters the first viewport or core interaction, update
the screenshot in `docs/assets/` and its caption in `README.md`. Keep diagrams in
Mermaid or another source-controlled format so contributors can review and
update them alongside the implementation.

## Reporting bugs and security issues

Use the GitHub issue templates for reproducible bugs, feature proposals, and
new-source proposals. Include public evidence links, but never paste tokens,
private data, or licensed source material into an issue.

Do not report a vulnerability publicly. Follow [`SECURITY.md`](SECURITY.md) so
maintainers can assess and coordinate a fix before disclosure.

By participating, you agree to follow the project
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
