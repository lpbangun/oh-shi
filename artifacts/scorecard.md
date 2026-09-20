# OH SHI ingest scorecards

Gate 0 template. Scores are integers 0–10 per row. Leave scores as `_` or `unscored` until a gate worker runs the required commands and records evidence.

## Scoring rules

- **Per-row bar:** A row passes only when its score is **9 or 10**. The 9/10 bar applies to **each named row**, not to an average across rows.
- **Evidence from commands:** Scores require pasted **command output** (for example `pnpm test`, ingest runs, benchmark scripts). Diff-reading or file inspection alone does not satisfy evidence.
- **Iteration:** Increment only after a validator review cycle. Gate 0 starts at iteration **0**.

## Gate metadata

| Field | Value |
| --- | --- |
| Active gate | Gate 2/3 (edtech scorecard) |
| Iteration | 2 |
| Validator verdict | `continue` |

Allowed validator verdicts: `continue` | `pass` | `stop-cap`

---

## Edtech scorecard

Vertical: **edtech**. Each row must reach 9/10 independently.

| Row | Score | Evidence | Notes |
| --- | --- | --- | --- |
| Legal sources | 9 | `pnpm test` 218/218 pass incl. `gate 2 code and fixtures avoid disallowed scrape hosts` and `benchmark fixtures avoid disallowed scrape hosts`. `rg` for `linkedin.com\|indeed.com\|glassdoor.com\|wellfound.com\|edtech.com` over `lib/edtech-pack.ts`, `lib/edtech-ingest.ts`, `lib/edtech-agent.ts`, `scripts/ingest-edtech-pack.ts`, `scripts/measure-edtech-yield.ts`, `packs/edtech.json`, `app/api/v1/agent` returns only denylist constants (`lib/edtech-pack.ts:42-47`) and `edtech_com_benchmark` field names in the measure script — no fetches of disallowed hosts. | `edtech.com` appears only as a benchmark text mention (`~756/~2003`, `notScraped: true`), never as a fetch target. |
| Company identity | 8 | Pack has 91 rows; `edtech-pack.test.ts` (Coursera+Duolingo, ≥20 well-known boards) passes. `evals/fixtures/edtech-benchmark/receipts.json` (generated 2026-09-20T01:40Z) attempts 27 boards incl. Coursera+Duolingo with per-board name/provider/board_id/external_ids; 25 live-complete. Test `benchmark receipts attempt coursera and duolingo` passes. | Bounded run covers 27/91 rows; remaining identities are LastRound-confirmed but not re-verified live in this run. Full-pack liveness unmeasured — not a 9. |
| Coverage vs Edtech.com | 8 | `artifacts/edtech-benchmark.md` exists (generated 2026-09-20T01:40Z) with honest measured ratios: `Complete live boards / ~756 companies: 25 / 756 (3.3%)` and `Observed open jobs / ~2,003 jobs: 202 / 2003 (10.1%)` (27 attempted, 25 complete, 202 open jobs). `pnpm measure:edtech` exists (`package.json`); receipts fixture parses/counts in tests. Gaps section names LastRound 9,935-row ATS directory as growth path instead of scraping Edtech.com. | Measured yield is real but bounded to 27/91 pack boards; full-pack yield unmeasured. Credible path + measured yield, honestly scoped — 8, not 9. |
| Role mix | 8 | Benchmark md reports live mix across 25 complete boards: GTM/sales 59, Operations 7, Engineering 43, Product 24, Other (curriculum/design) 69, with all four families confirmed present; receipts carry per-board role histograms + sample titles. `edtech-ingest.test.ts` mixed-role fixture tests pass. | Live mix proven on the bounded 27-board run only; full-pack live mix unmeasured. Fixture + bounded-live — 8. |
| Open/close honesty | 8 | Tests pass: complete-snapshot set-diff closes missing ids, incomplete/403/null-ids quarantine with zero closures, mass-delete guard, plus `recorded snapshot diff fixture shows opened and closed jobs` (prior/after pair: c1 closed, c3 opened, d1→d2 turnover). `scripts/ingest-edtech-pack.ts` loads previous snapshot (`resumedFrom`), records per-board opened/closed receipts, writes timestamped `outputs/edtech-ingest-*.json`; benchmark md has a snapshot-diff section (0/0 in its window). | Diff mechanics proven via fixtures + CLI; no live multi-run diff artifact inspected (benchmark window shows 0 opened / 0 closed). — 8. |
| Board × title filters | 9 | Public `GET /api/v1/agent/jobs` (`app/api/v1/agent/jobs/route.ts`, no auth) wires `buildEdtechAgentJobsPayload` + `loadEdtechAgentStore`, accepts `boards=`/`titles=` arrays (comma + repeated params). Tests pass: `queryEdtechAgent returns count first and excludes unrequested boards`, `filters by title and role family`, `returns empty results for empty boards`, `rejects unknown and invalid parameters` (unknown param, invalid board id, missing boards), `supports comma and repeated board parameters`, `agent jobs route is a public GET surface without auth`. | Requested-subset-only surface with empty/error/multi-board coverage — meets the 9 bar. |
| Agent ingest | 8 | Compact contract tested (`compact agent rows omit description and keep employer ATS URLs`: no `description`, stable id, `applyUrl == canonicalUrl` on ATS host, `vertical=edtech`) and now served by the public agent endpoint (`loadEdtechAgentStore` → snapshot store). Live canonical-URL yield measured on 25 boards (202 jobs). | End-to-end live wiring (scheduled ingest output → route store) depends on `outputs/` snapshots in prod, not proven here. — 8. |
| Tests | 9 | `pnpm test`: 218 tests / 218 pass / 0 fail (was 203; +15 incl. benchmark, agent payload, workflow tests). `pnpm typecheck`: clean (`tsc --noEmit`, no errors). | Live-network coverage still bounded (27-board benchmark run + `--limit=1 --fresh --dry-run` → success=1); deterministic suites strong. |
| Benchmark writeup | 9 | `artifacts/edtech-benchmark.md` exists with: generation timestamp, Edtech.com reference (~756 companies / ~2,003 jobs, checked 2026-09-19, explicitly not scraped), pack scope (91 rows, 27 attempted, 25 complete, 2 failed, 202 jobs), quoted ratio lines `25 / 756 (3.3%)` and `202 / 2003 (10.1%)`, per-board receipts table (incl. quizlet-2/clever 404s), role-mix table, snapshot-diff section, gaps + LastRound growth path, receipts pointer. Ratios verified by tests (`receipts fixture parses and counts complete boards`, `markdown exists with required coverage sections`). | Ratios measured from receipts, not invented; bounded scope honestly disclosed. |
| Growth hook | 9 | `.github/workflows/daily-edtech-pack.yml`: daily cron `15 8 * * *` (not the 2-hour refresh), `timeout-minutes: 45`, `pnpm install --frozen-lockfile`, full-pack `pnpm ingest:edtech --concurrency=6` (no `--limit`, no `--fresh` so it resumes for real diffs), `upload-artifact@v7` of `outputs/edtech-ingest-*.json` (14d retention), summarize step. CLI loads previous snapshot counts (`resumedFrom`) and records per-board opened/closed receipts. Documented in `README.md` (daily `pnpm ingest:edtech` + workflow path) and `app/llms.txt/route.ts` (edtech pack jobs entrypoint). Workflow shape pinned by test (`daily edtech pack workflow exists with bounded daily ingest`). | Daily re-fetch + snapshot-diff recording + artifact upload + docs — meets the 9 bar. |

---

## All-types scorecard

Vertical: **all** (non-edtech plus edtech regression). Each row must reach 9/10 independently.

| Row | Score | Evidence | Notes |
| --- | --- | --- | --- |
| Same legal-source bar | unscored | | |
| Non-edtech same ingest | unscored | | |
| Filters with vertical=all | unscored | | |
| Compact agent contract | unscored | | |
| Tests cover non-edtech + edtech regression | unscored | | |
| No LinkedIn/Indeed adapters | unscored | | |
| Daily refresh bounded | unscored | | |
| Closures still set-diff | unscored | | |
| README / llms.txt | unscored | | |
| Edtech not regressed below 9 | unscored | | |
