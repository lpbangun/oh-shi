# Dependability implementation log

- [x] Baseline verified: repository instructions/worktree inspected; typecheck,
  150 evaluations, and production build passed before changes. Repository lint
  had two pre-existing errors in the unrelated promo project.
- [x] Data reliability: duplicate source identities are deterministic, malformed
  successful URLs cannot prove absence, active-source freshness is explicit, and
  fetch failures remain distinct from closure evidence.
- [x] Shared search: browser and public APIs use one bounded D1 query with
  open-by-default semantics, complete totals, deterministic ordering, and pages.
- [x] Public browsing: job state is encoded in the URL, Back/Forward reloads it,
  and each row exposes source, semantic verification time, and a posting link.
- [x] Incremental access: job IDs include an exact-identity hash; openings,
  material updates, and closures emit retry-safe events; changes use tuple-safe
  resumable checkpoints with explicit expiry recovery.
- [x] Final verification: typecheck, 155 evaluations, scoped lint, production
  build, and 27 desktop/mobile browser checks passed. Thirteen browser checks
  were intentionally skipped by their project annotations. Repository-wide lint
  still reports the same two pre-existing errors in `artifacts/ohshi-promo`.

The product boundary remains unchanged: Oh Shi publishes public aggregator data;
personal job-search workflow features belong to Jobsss.
