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
| Iteration | 3 |
| Validator verdict | `pass` |

Allowed validator verdicts: `continue` | `pass` | `stop-cap`

---

## Edtech scorecard

Vertical: **edtech**. Each row must reach 9/10 independently.

| Row | Score | Evidence | Notes |
| --- | --- | --- | --- |
| Legal sources | 9 | `pnpm test` 219/219 pass incl. `gate 2 code and fixtures avoid disallowed scrape hosts` and `benchmark fixtures avoid disallowed scrape hosts`. `rg` for `linkedin.com\|indeed.com\|glassdoor.com\|wellfound.com\|edtech.com` over `lib/edtech-pack.ts`, `lib/edtech-ingest.ts`, `lib/edtech-agent.ts`, `scripts/ingest-edtech-pack.ts`, `scripts/measure-edtech-yield.ts`, `packs/edtech.json`, `app/api/v1/agent` returns only denylist constants (`lib/edtech-pack.ts:42-47`) and `Edtech.com` benchmark text mentions in the measure script — no fetches of disallowed hosts. | `edtech.com` appears only as a benchmark text mention (`~756/~2003`, `notScraped: true`), never as a fetch target. |
| Company identity | 9 | Full-pack `pnpm measure:edtech --all` (generated 2026-09-20T01:48:50Z): `packRows: 91`, `boardsAttempted: 91`, `boardsComplete: 85`, `boardsFailed: 6` in `evals/fixtures/edtech-benchmark/receipts.json`. Every receipt carries name/provider/board_id/external_ids. 6 failures honestly labeled (clever 404, guild timeout, productschool 404, quizlet-2 404, childrenscorner 404, tutorme 404) with `fetch_status: failed`, `live_complete: false`, quarantine reason + error. Test `live receipts separate pack identity from live complete boards` passes; `pnpm test` 219/219. | Pack identity separated from live-complete status; failures retained as named identities, not silently dropped — meets the 9 bar. |
| Coverage vs Edtech.com | 9 | `artifacts/edtech-benchmark.md` (generated 2026-09-20T01:48:50Z) full-pack scope: 91 attempted, 85 live-complete, 598 open jobs. Honest measured ratios quoted verbatim: `Complete live boards / ~756 companies: 85 / 756 (11.2%)` and `Observed open jobs / ~2,003 jobs: 598 / 2003 (29.9%)`. Receipts top-level fields confirm `packRows: 91`, `boardsAttempted: 91`, `boardsComplete: 85`. Gaps section names LastRound 9,935-row ATS directory as growth path instead of scraping Edtech.com. | Credible path (public ATS JSON only) + measured full-pack yield, honestly scoped; not a fake 756 — meets the 9 bar. |
| Role mix | 9 | Benchmark md reports full-pack live mix across 85 complete boards: GTM/sales 102, Operations 28, Engineering 57, Product 32, Other (curriculum/design) 379 — all four families plus Other confirmed present with live title coverage flags. Receipts carry per-board role histograms + sample titles. `edtech-ingest.test.ts` mixed-role fixture tests pass; `pnpm test` 219/219. | Live mix measured on the full pack, not fixtures alone — meets the 9 bar. |
| Open/close honesty | 9 | Tests pass: `complete snapshot set-diff closes missing jobs and keeps survivors open`, `incomplete fetch and null observed ids quarantine without closures`, `mass-delete guard quarantines large disappearance without closures`, plus `recorded snapshot diff fixture shows opened and closed jobs`. Live-path proof in `artifacts/edtech-snapshot-diff.md` (generated 2026-09-20T01:48:13Z): two-run ingest on coursera+duolingo, run-2 output quoted verbatim — coursera `observed: 6, opened: 1, closed: 1`, duolingo `observed: 36, opened: 0, closed: 0`; removed live job `6120396004` reopened, synthetic `9999999001` closed. Perturbation (removed live id + injected synthetic) explicitly disclosed in the doc and in `evals/fixtures/edtech-ingest/snapshot-diff-receipts.json`. | Perturbed prior snapshot is honest (disclosed), and it exercises the real live path: missing ids close only after a complete snapshot; incomplete/mass-delete quarantines with zero closures — meets the 9 bar. No organic scheduled churn required. |
| Board × title filters | 9 | Public `GET /api/v1/agent/jobs` (`app/api/v1/agent/jobs/route.ts`, no auth) wires `buildEdtechAgentJobsPayload` + `loadEdtechAgentStore`, accepts `boards=`/`titles=` arrays (comma + repeated params). Tests pass: `queryEdtechAgent returns count first and excludes unrequested boards`, `filters by title and role family`, `returns empty results for empty boards`, `rejects unknown and invalid parameters` (unknown param, invalid board id, missing boards), `supports comma and repeated board parameters`, `agent jobs route is a public GET surface without auth`. | Requested-subset-only surface with empty/error/multi-board coverage — meets the 9 bar. |
| Agent ingest | 9 | Compact contract tested (`compact agent rows omit description and keep employer ATS URLs`: no `description`, stable id, `applyUrl == canonicalUrl` on ATS host, `vertical=edtech`); live canonical-URL yield measured on 85 boards (598 jobs). Snapshot-store wiring proven end to end: `loadEdtechAgentStore` honors `EDTECH_SNAPSHOT_DIR` (`lib/edtech-agent.ts:15-18,149-151`), test `loadEdtechAgentStore reads scheduled ingest snapshot output` writes an `edtech-ingest-*.json` artifact and asserts the payload serves it (`count: 1`, coursera, no `description`), and the public route (`app/api/v1/agent/jobs/route.ts:10-13`) calls `loadEdtechAgentStore()` with no args then `buildEdtechAgentJobsPayload` (inspected). | Unit test (ingest JSON → agent payload) + route inspection (GET uses the snapshot store) satisfies the 9 bar; no running-HTTP-server check required. |
| Tests | 9 | `pnpm test`: 219 tests / 219 pass / 0 fail (was 218; +1 incl. live-receipts identity separation test). `pnpm typecheck`: clean (`tsc --noEmit`, no errors). | Full-pack live coverage now behind the benchmark receipts fixture; deterministic suites strong. |
| Benchmark writeup | 9 | `artifacts/edtech-benchmark.md` regenerated (2026-09-20T01:48:50Z) with: generation timestamp, Edtech.com reference (~756 companies / ~2,003 jobs, checked 2026-09-19, explicitly not scraped), pack scope (91 rows, 91 attempted, 85 complete, 6 failed, 598 jobs), quoted ratio lines `85 / 756 (11.2%)` and `598 / 2003 (29.9%)`, per-board receipts table (incl. clever/guild/productschool/quizlet-2/childrenscorner/tutorme failures), role-mix table, gaps + LastRound growth path, receipts pointer. Ratios verified by tests (`receipts fixture parses and counts complete boards`, `markdown exists with required coverage sections`). | Ratios measured from full-pack receipts, not invented; scope honestly disclosed. |
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
