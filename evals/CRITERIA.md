# OH SHI evaluation criteria

The production build is allowed only after the local eval gate passes.

## Data integrity

- Company, job, and change identifiers are unique.
- Every job references a known company.
- Every change references a known company or job.
- Hiring signal and evidence confidence remain within 0-100.
- Stored score totals equal their structured calculation receipts.
- At least 12 tracked companies cover at least eight normalized sectors.
- Company/day and sector/day movement aggregates preserve underlying evidence.
- Seed open-job counts match the actual seed records.
- Canonical URLs are HTTPS and verified-open jobs do not have a closed timestamp.
- Company records include stage, founding year, funding context, source evidence, and verification time.

## Canonical job normalization

- U.S. eligibility recognizes explicit U.S. addresses, U.S. locations, and remote roles.
- Role classification covers people operations, GTM, operations, research, engineering, product, and fallback roles.
- Extracted summaries are normalized and capped at 220 characters.

## Agent contract

- The preferred intelligence route discovers and serves jobs, companies, movements,
  and sectors with validated filters and deterministic cursor pagination.
- Compatibility routes remain available for companies, jobs, changes, and JSONL exports.
- Read endpoints do not require authentication.
- Agent policy is valid JSON and declares public read access.
- API envelopes expose schema version, generation time, cursor, license, and data.
- The protected refresh route requires an authorization header.

## Product hygiene

- No starter skeleton, starter branding, or removed skeleton dependency remains.
- No common mojibake sequences remain in source or public copy.
- Social metadata points to a real, sufficiently large social card.
- MIT and data-license files exist.
- Sites configuration contains the real project ID and D1 binding.
- TypeScript passes before evals, and evals pass before the production build.
- The eval launcher works when WSL inherits a Windows-mounted temporary directory.
- Desktop and 320px browser flows pass keyboard, pagination, reduced-motion, and
  automated accessibility checks.
- CI performs frozen install, lint, typecheck, evals, build, E2E, and a
  high-severity production dependency audit.

## Live contract

The separate live eval checks discovery, real record freshness, canonical URLs,
validated filters, company pagination, movement evidence, and score-receipt parity.
