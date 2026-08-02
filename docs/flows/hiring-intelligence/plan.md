# Task Plan: Hiring intelligence discovery

> Source spec: `docs/flows/hiring-intelligence/spec.md`
>
> Approved 2026-07-27. Mobbin was explicitly skipped for this release.

## Iteration 1 — unblock core usability and release wiring

1. **Add test foundations** — install/configure Playwright and accessibility tooling;
   create deterministic large fixtures. Done when a smoke browser test runs locally
   and in CI.
2. **Fix filter-menu scrolling** — ignore internal menu scroll, retain outside-scroll
   close, clamp to viewport, and complete keyboard behavior. Done when wheel,
   scrollbar, touch-equivalent, Escape, and focus-return tests pass.
3. **Separate pagination state** — retain job page sizing, fix companies at 10, add
   What changed at 25, and use section-specific scroll/focus anchors. Done when
   12-company and 27-change fixtures traverse without duplicates or gaps.
4. **Reorder the market section** — establish movements → sector map →
   companies/funding → What changed. Done when DOM order is pinned by E2E.
5. **Wire CI** — add push/PR quality workflow with frozen install, lint, typecheck,
   eval, browser E2E, and build; fail fast on missing refresh variables. Done when
   local workflow-equivalent commands pass and the workflow is syntactically valid.

## Iteration 2 — market intelligence and explainability

6. **Define normalized sectors and expand tracked sources** — preserve detailed
   industries, add sector mapping, expand the verified source registry, and provide
   an upsert/migration path for existing D1 data. Done when at least 12 companies
   cover eight sectors and every source passes integrity checks.
7. **Derive market movements** — implement company/day and sector/day aggregation
   with stable IDs and evidence references. Done when aggregation fixtures prove
   totals, isolation, ordering, and no double counting.
8. **Build clickable movements** — render movement rows and route company/job/sector
   actions correctly. Done when mouse and keyboard E2E paths reach the right record
   or filtered jobs.
9. **Create score receipts** — expose hiring-signal and evidence-confidence component
   breakdowns from the calculation module; recompute stored totals. Done when every
   component sum matches every displayed/API total and contradictory forecast copy is
   removed.
10. **Add accessible explainers** — reuse receipts in table headers, mobile rows,
    modals, and detail pages. Done when keyboard, focus, screen-reader naming, and axe
    checks pass.

## Iteration 3 — agent consolidation and production hardening

11. **Build the unified intelligence contract** — add capability discovery,
    validated views/filters, deterministic cursor pagination, movement/sector data,
    and score receipts; keep old routes compatible. Done when runtime route tests
    cover success, invalid input, detail parity, and pagination walks.
12. **Make agent discovery operational** — update `/llms.txt`, agent policy, robots,
    and homepage agent copy with exact field names and prompt recipes. Done when
    discovery parity tests pass.
13. **Run the independent NLP operation test** — start from a fresh OpenCode/Codex
    session with `/llms.txt` only and execute: remote Operations jobs at
    high-confidence companies; Cognition changes since a date; sectors gaining roles;
    funding raises ten at a time; and explanation of one company's signal/confidence.
    Done when returned IDs, counts, calculations, and source URLs match fixtures.
14. **Harden runtime and data** — add refresh idempotency, schema-drift, export,
    record-freshness, error-state, large-data, and dependency-security checks. Done
    when all release criteria pass with no unexplained high-severity advisory.
15. **Deploy and live-verify** — deploy the saved version, run extended live evals,
    and inspect final desktop/mobile flows. Done when production returns current
    records and every acceptance item in the spec is evidenced.

## Iteration loop and stop rule

- At the end of each iteration, rerun typecheck, lint, unit/integration evals,
  browser E2E, production build, and the applicable live checks.
- Give OpenCode the failures and current diff, then compare its independent verdict
  against this spec.
- Hot-fix failed criteria and repeat, up to three implementation iterations.
- For funding discovery, conversion means a current, definitive fixture becomes
  one cited movement, advances newer company funding facts, and produces a
  matching recomputed score; the benchmark stops on conversion or after three passes.
- Do not call the goal complete unless every spec acceptance criterion has direct
  evidence. If iteration three still exposes a release blocker, report it rather than
  redefining production readiness.

## Checkpoint

The product owner approved the repo-grounded draft and explicitly requested that
Mobbin be skipped. Implementation proceeded from the approved spec.
