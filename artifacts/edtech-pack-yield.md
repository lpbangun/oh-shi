# Edtech pack yield (Gate 1)

Generated: 2026-09-20T01:25:51.505Z

## Coverage comparison

Edtech.com benchmark (checked 2026-09-19): ~756 companies / ~2,003 open jobs. This pack is **not** a scrape of Edtech.com; it is a precision-reviewed subset built from legal ATS directory + Wikidata identity joins.

Live measured yield (bounded 27-board run via `pnpm measure:edtech`) is recorded in `artifacts/edtech-benchmark.md` with per-board receipts at `evals/fixtures/edtech-benchmark/receipts.json`. Pack identity (91 rows) is tracked separately from live-complete boards.

## Builder counts

| Stage | Count |
| --- | ---: |
| LastRound greenhouse/lever/ashby rows scanned | 9935 |
| Keyword-matched candidates (pre-website) | 27 |
| Wikidata education/edtech entities loaded | 2 |
| Rows with Wikidata website join | 0 |
| Curated must-include employers | 91 |
| Rejected false positives | 129 |
| Rejected (no first-party website) | 27 |
| **Reviewed rows in pack** | **91** |

## Review rule

Include LastRound greenhouse/lever/ashby boards when (a) manually curated known education employer, (b) company name matches education/learning keywords after false-positive exclusions, or (c) Wikidata industry/education entity label matches with website join. Reject generic learning false positives (machine learning, campus recruiting, non-education academies). Dedup provider+board_id; website must be first-party HTTPS from Wikidata P856 or curated override.

## Attribution

- LastRound AI ATS company directory (CC BY 4.0), https://github.com/fyrosofttech/lastroundai-hiring-data
- Wikidata CC0 website evidence (https://www.wikidata.org/wiki/Wikidata:Copyright)
