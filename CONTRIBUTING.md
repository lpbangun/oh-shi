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

## Local development

Use Node.js 22.13 or newer and pnpm 11.17.0 or newer.

```bash
pnpm install
pnpm dev
```

Before opening a pull request, run the narrowest useful check while iterating,
then the full gate:

```bash
pnpm typecheck
pnpm lint
pnpm eval
pnpm quality:ci
```

`pnpm quality` runs typecheck, deterministic evaluations, and the production
build. `pnpm quality:ci` also runs lint, Playwright browser coverage, and the
accessibility/usability checks.

## Pull requests

Keep a change focused and explain the user or operator outcome in the PR body.
For changes that affect data behavior, include the invariant that should remain
true and the test that protects it.

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
