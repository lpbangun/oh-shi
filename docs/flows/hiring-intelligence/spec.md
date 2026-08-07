# Flow Spec: Hiring intelligence discovery

> APPROVED 2026-07-27 — the product owner approved implementation from this
> repo-grounded draft and explicitly waived Mobbin research for this release.

## Goal

A person should be able to move from verified jobs to an understandable market
movement, see where that movement sits by sector and company/funding context, and
reach the underlying record or source without guessing what a score means.

An AI agent should be able to answer the same questions through one documented,
deterministic entrypoint rather than reverse-engineering and joining several APIs.

## Reference and rationale

- Mobbin and other external design-reference research were explicitly skipped.
- The repository's existing compact editorial table style, canonical job cards,
  visible hiring state, filters, and source receipts are the design baseline.
- We will not copy brand colors, rounded-card styling, testimonials, marketing
  funnels, or banking/spend-management vocabulary.
- The app's existing tokens, compact editorial table style, explicit source
  receipts, and public-access model remain authoritative.

## Flow model

Goal: discover a verified opportunity, understand the surrounding hiring movement,
and inspect its evidence.

Beats: find roles → notice movement → understand sector context → compare companies
and funding → inspect the audit trail → reuse the same facts through an agent.

| # | State | User's job | Inputs | Output | Key pattern |
|---|---|---|---|---|---|
| 1 | Open jobs | Find a relevant verified role | Text, status, sector, department, location, sort | Filtered, paged roles | Search plus scrollable column menus |
| 2 | Market movements | See what actually moved | Verified change events, jobs, companies | Grouped company/day and sector/day movements | Clickable evidence-backed bundles |
| 3 | Sector map | Compare breadth and direction | Normalized sectors and 30-day deltas | Sector totals and drilldown | Compact interactive map |
| 4 | Companies and funding | Compare company context | Company facts, score receipts, funding fields | Ten companies per page | Sortable table/list with explainers |
| 5 | What changed | Audit underlying raw changes | Canonical change events | Twenty-five events per page | Chronological source-linked feed |
| 6 | Agent access | Ask the same questions in natural language | `/llms.txt` plus deterministic query parameters | Cited records from one intelligence endpoint | Capability document plus filtered views |

Transitions and branches:

- S1 filter/sort → S1 results; a role opens its record; a company opens its record.
- S1 internal menu scroll → S1 with menu still open; page/ancestor scroll closes it.
- S2 company movement → company record; individual role → job record; sector/role
  bundle → S1 with matching filters.
- S3 sector → drilldown; "Filter jobs" → S1 with the sector applied.
- S4 company row → company record; info action → score/confidence receipt.
- S5 source → canonical evidence in a new tab; pagination stays anchored to S5.
- Empty data renders a useful empty state, not an empty table.
- Loading and D1/runtime errors render a recoverable page-level state and do not
  publish invented totals.

## Keep / drop / adapt / add

| Decision | Reference/current pattern | Project mapping |
|---|---|---|
| Keep | Immediate job discovery | `JobBoard` search, filters, rows, and record modals |
| Keep | Explicit source and verification state | Job/company detail routes and canonical URLs |
| Drop | Marketing capture, testimonials, and gated conversion | Public, account-free OH SHI flow |
| Adapt | Wellfound category browsing | Scrollable `ColumnMenu` plus normalized sector taxonomy |
| Adapt | Activity dashboard | Derived, clickable market movements backed by raw events |
| Adapt | KPI framing | Score/confidence receipts with published component weights |
| Add | Market hierarchy | Movements → sector map → companies/funding → What changed |
| Add | Deterministic agent navigation | `GET /api/v1/intelligence?view=…` and prompt recipes |
| Add | Production evidence | Browser E2E, accessibility scan, CI gate, live contract checks |

## States and project mapping

| State | Entry condition | Exit / next | Project route or component |
|---|---|---|---|
| Open jobs | Homepage load | Role/company record or filtered page | `app/components/JobBoard.tsx`, `ColumnMenu.tsx` |
| Market movements | Jobs loaded | Company/job modal or job filter | New movement derivation in `lib/derive.ts`; homepage movement list |
| Sector map | Derived sector data available | Sector drilldown or filtered jobs | Existing sector map in `JobBoard.tsx` |
| Companies and funding | Company data available | Company record or explanation | Existing desktop table/mobile list, fixed page size 10 |
| What changed | Change data available | Source or next/previous 25 | Existing change feed moved last |
| Agent access | `/llms.txt` discovery | Intelligence query and cited data | New `app/api/v1/intelligence/route.ts`; existing APIs remain compatible |

## Data semantics

### Market movements

- Raw `ChangeEvent` records remain immutable audit facts.
- The default human grouping is company plus UTC calendar day plus direction.
  Multiple openings become, for example, “Cognition opened 3 roles: X, Y, Z.”
- A sector/day grouping supports statements such as “6 EdTech product postings
  opened yesterday.” It is only emitted when every counted event resolves to a
  verified job and normalized sector.
- Funding announcements remain standalone company movements and are not mixed into
  job counts.
- Every aggregate carries stable IDs, underlying event IDs, company/job references,
  count, occurred-at bounds, and source URLs. Aggregates never replace the raw feed.

### Sector breadth

- Preserve `industry` as the detailed factual label.
- Add a normalized `sector` drawn from the published taxonomy: Healthcare,
  Biotechnology & Life Sciences, Artificial Intelligence, Developer Tools,
  Enterprise Software, Science & Research, Food & Commerce, Financial
  Technology, Education Technology, Climate & Energy, Consumer, Cybersecurity,
  Logistics & Mobility, Media & Entertainment, Hardware & Robotics, Government
  & Defense, Real Estate, Human Resources, Legal Technology, and Other.
- A sector is shown only when at least one tracked, source-verified company maps to
  it. The UI must not manufacture empty breadth.
- Production readiness requires at least 12 tracked companies across at least eight
  normalized sectors, with canonical careers/source URLs and refresh coverage.

### Hiring signal

“Hiring signal” is a directional hiring-momentum score, not a probability or a
calibrated forecast. The displayed value must be computed from stored inputs:

- Open-role volume: 0–30
- Net open-role growth over 90 days: 0–30
- Funding stage and recency: 0–25
- Canonical-board freshness: 0–15

The calculation API returns the total, methodology version, inputs, and each
component's points/max. The component sum must equal the displayed value after the
documented rounding rule.

### Evidence confidence

Confidence measures the quality and freshness of evidence, not hiring attractiveness:

- Verification recency: 0–40
- Share of open roles verified in the latest refresh: 0–30
- Record completeness: 0–20
- Independent-source corroboration: 0–10

The same structured receipt powers the UI explainer, company record, and agent
response. Seeded or refreshed totals must never diverge from this calculation.

## Unified agent contract

`GET /api/v1/intelligence` is the preferred entrypoint. With no `view`, it returns
machine-readable capabilities and parameter definitions. Supported views:

- `jobs`: `q`, `status`, `company`, `sector`, `role_family`, `location`,
  `remote_status`, `limit`, `cursor`
- `companies`: `q`, `sector`, `min_signal`, `min_confidence`, `limit`, `cursor`
- `movements`: `after`, `before`, `type`, `company`, `sector`,
  `group=company_day|sector_day|none`, `limit`, `cursor`
- `sectors`: sector totals, company counts, open roles, 30-day delta

Every response includes `schema_version`, `generated_at`, `data_as_of`, `view`,
`applied_filters`, `page`, `methodology_version`, `license`, and `data`.
Unknown parameters, invalid enums, and invalid cursors return a documented 400
instead of silently returning unfiltered data. Existing endpoints remain as
compatibility surfaces.

`/llms.txt` documents exact camelCase response fields and gives prompt-to-request
recipes. A fresh Codex/OpenCode agent must be able to answer the agreed prompt suite
using only `/llms.txt` and returned links; the endpoint itself does not need an LLM
or accept raw prompts.

## UI mapping

| Pattern | Project implementation |
|---|---|
| Scrollable filter menu | Existing `ColumnMenu`, viewport-clamped internal scroller; outside scroll closes |
| Movement action | Button/row with sibling source link; never a nested interactive element |
| Sector drilldown | Existing sector tile and drilldown components using project tokens |
| Signal/confidence explainer | Accessible info button plus popover/dialog rendered from score receipt |
| Fixed pagination | Reusable pager semantics; companies 10, raw changes 25 |
| Loading/empty/error | Existing panel, line, muted, and accent tokens; no reference brand values |

## Interaction, accessibility, and motion

- Menus support Escape, Arrow Up/Down, Home/End, focus return, and internal wheel,
  touch, and scrollbar use.
- Movement, sector, company, and explainer actions are real buttons or links.
- Modals trap focus and restore focus on close.
- Pagination announces the visible range and keeps focus/scroll at the relevant
  section, not the top of the full market block.
- Existing motion is retained only when `prefers-reduced-motion` permits it.
- Desktop and 320px mobile layouts must have no page-level horizontal overflow.

## Instrumentation

Emit privacy-safe events for `filter_applied`, `movement_opened`,
`sector_drilled_down`, `score_explainer_opened`, `company_page_changed`,
`changes_page_changed`, and `agent_view_requested`. Include only filter keys,
grouping type, page number, and stable record IDs; do not log free-text prompts.

## Acceptance criteria

- [ ] Location/sector/department menus scroll internally without closing.
- [ ] Hiring movements are aggregated, evidence-backed, keyboard accessible, and
  navigate to the relevant record or filtered jobs.
- [ ] Funding announcements are discovered daily, remain standalone company
  movements, cite an official or reputable source, and trigger score recomputation.
- [ ] At least 12 source-verified companies cover at least eight normalized sectors.
- [ ] Order is movements → sector map → companies/funding → What changed.
- [ ] Companies show no more than 10 rows per page on every viewport.
- [ ] What changed shows no more than 25 raw events per page.
- [ ] Signal and confidence info actions expose structured, matching calculations.
- [ ] All published score totals are computed, not stale hand-entered seed values.
- [ ] One intelligence endpoint covers jobs, companies, movements, and sectors with
  validated filters and real cursor pagination.
- [ ] A fresh OpenCode/Codex run can answer the natural-language acceptance prompts
  from `/llms.txt` alone and cite returned record IDs/source URLs.
- [ ] PR/push CI runs frozen install, lint, typecheck, evals, browser E2E, and build.
- [ ] Post-deploy live checks validate record freshness, filters, pagination,
  aggregation, discovery, and one score receipt.
- [ ] Loading, empty, error, keyboard, reduced-motion, and mobile branches pass.
- [ ] No high-severity production dependency advisories remain without an explicit,
  time-bounded exception.
