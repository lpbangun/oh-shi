# OH SHI ingest scorecards

Gate 0 template. Scores are integers 0–10 per row. Leave scores as `_` or `unscored` until a gate worker runs the required commands and records evidence.

## Scoring rules

- **Per-row bar:** A row passes only when its score is **9 or 10**. The 9/10 bar applies to **each named row**, not to an average across rows.
- **Evidence from commands:** Scores require pasted **command output** (for example `pnpm test`, ingest runs, benchmark scripts). Diff-reading or file inspection alone does not satisfy evidence.
- **Iteration:** Increment only after a validator review cycle. Gate 0 starts at iteration **0**.

## Gate metadata

| Field | Value |
| --- | --- |
| Active gate | Gate 0 |
| Iteration | 0 |
| Validator verdict | `continue` |

Allowed validator verdicts: `continue` | `pass` | `stop-cap`

---

## Edtech scorecard

Vertical: **edtech**. Each row must reach 9/10 independently.

| Row | Score | Evidence | Notes |
| --- | --- | --- | --- |
| Legal sources | unscored | | |
| Company identity | unscored | | |
| Coverage vs Edtech.com | unscored | | |
| Role mix | unscored | | |
| Open/close honesty | unscored | | |
| Board × title filters | unscored | | |
| Agent ingest | unscored | | |
| Tests | unscored | | |
| Benchmark writeup | unscored | | |
| Growth hook | unscored | | |

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
