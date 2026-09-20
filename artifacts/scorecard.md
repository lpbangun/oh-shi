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
| Iteration | 1 |
| Validator verdict | `continue` |

Allowed validator verdicts: `continue` | `pass` | `stop-cap`

---

## Edtech scorecard

Vertical: **edtech**. Each row must reach 9/10 independently.

| Row | Score | Evidence | Notes |
| --- | --- | --- | --- |
| Legal sources | 9 | `pnpm test` 203/203 pass incl. `gate 2 code and fixtures avoid disallowed scrape hosts`; grep over `lib/edtech-pack.ts`, `lib/edtech-ingest.ts`, `scripts/ingest-edtech-pack.ts`, `scripts/build-edtech-pack.ts`, `packs/edtech.json` shows only denylist constants, a false-positive regex, and a benchmark text mention — no fetches of LinkedIn/Indeed/Glassdoor/Wellfound/Edtech.com/Crunchbase/YC dumps; pack evidence URLs are greenhouse/lever/ashby APIs only. | Pre-existing YC/Crunchbase refs in `lib/source-registry.ts` / `lib/funding-discovery.ts` are outside the edtech pack path (official YC site, Crunchbase News RSS publisher link), not edtech job proof. |
| Company identity | 7 | Pack has 91 rows (`pack_rows=91`); `edtech-pack.test.ts` requires Coursera+Duolingo and ≥20 well-known boards, passing. Spot live check: `--limit=2 --fresh --dry-run` returned success=2. | No live verification across the pack that each board is live/complete; identity rests on curation + unit tests, not measured board liveness. |
| Coverage vs Edtech.com | 6 | `artifacts/edtech-pack-yield.md` honestly reports 91 reviewed rows vs ~756 companies / ~2003 jobs benchmark (checked 2026-09-19), explicitly not a scrape; `packs/edtech.json` provider mix greenhouse=50/lever=20/ashby=21. | No measured live yield across the pack — only a 2-board dry run (openJobs=1). Ratio is honest but yield is unmeasured. |
| Role mix | 6 | `edtech-ingest.test.ts` mixed-role fixture test passes: Account Executive, Curriculum Specialist, Customer Success Manager, Operations Manager, Software Engineer (+Instructional Designer in lever fixture). | Fixture lanes only; live dry run surfaced 1 open job from 2 boards, so live role mix is unproven. |
| Open/close honesty | 8 | Tests pass: complete-snapshot set-diff closes missing ids, incomplete/403/null-ids quarantine with zero closures, mass-delete guard quarantines. Logic implemented in `lib/edtech-ingest.ts` (`resolveEdtechFetch`, `ingestEdtechBoardSnapshot`, `planCanonicalClosures`). | Fixture-level only; no live snapshot history / diff artifact yet. |
| Board × title filters | 5 | `filterCompactJobs` unit-tested (board+title subset returns only Software Engineer). | Internal helper only — no public agent board×title surface exists (`app/api` has no edtech route; Gate 4 unopened). |
| Agent ingest | 7 | Compact-row test passes: no `description` key, stable `edtechJobId`, `apply_url == canonical_url` on employer ATS host, `vertical=edtech`. | Data contract exists and is tested, but no live consumer / public agent endpoint (Gate 4 unopened); live canonical-URL yield measured on 2 boards only. |
| Tests | 9 | `pnpm test`: 203 tests / 203 pass / 0 fail. `pnpm typecheck`: clean (no errors). Suites cover pack validation, mixed-role ingest, dedupe, set-diff close, quarantine paths, compact contract, filters, snapshot loading. | Live-network coverage is thin (2-board dry run); deterministic suites are strong. |
| Benchmark writeup | 3 | `artifacts/edtech-benchmark.md` does NOT exist (`ls` → No such file). Only `artifacts/edtech-pack-yield.md` (builder counts, no live per-board counts). | Missing required artifact; live counts vs Edtech.com unwritten. |
| Growth hook | 4 | CLI exists (`pnpm ingest:edtech` → `scripts/ingest-edtech-pack.ts` with `--limit/--dry-run/--fresh/--concurrency/--output`) and runs live. | No documented daily command/workflow: no pack-ingest GitHub workflow (existing `daily-refresh.yml` is the 2-hour OH SHI refresh), no schedule doc. |

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
