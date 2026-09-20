# Edtech live benchmark

Generated: 2026-09-20T01:40:00.250Z

## Edtech.com reference (not scraped)

Edtech.com benchmark reminder: ~756 companies / ~2,003 open jobs (checked 2026-09-19). This measurement does **not** scrape Edtech.com; it fetches public ATS JSON boards from the reviewed pack only.

## Pack and measurement scope

- Reviewed pack rows (company identities): **91**
- Boards attempted in this run (bounded, limit=27): **27**
- Live complete boards: **25**
- Quarantined boards: **0**
- Failed boards: **2**
- Open jobs observed on complete boards: **202**

## Honest ratios vs Edtech.com

- Complete live boards / ~756 companies: **25 / 756 (3.3%)**
- Observed open jobs / ~2,003 jobs: **202 / 2003 (10.1%)**

Pack identity and live-complete board are tracked separately: a row may remain in the pack as a named public board identity while failing live fetch (404, empty non-complete payload, or quarantine).

## Role mix (live complete boards)

| Role family | Count |
| --- | ---: |
| GTM / sales | 59 |
| Operations | 7 |
| Engineering | 43 |
| Product | 24 |
| Other (curriculum, design, etc.) | 69 |

Live title coverage in this run:
- Sales / GTM titles present: yes
- Curriculum / instructional titles present: yes
- Operations / customer-success titles present: yes
- Engineering titles present: yes

## Per-board receipts

| Company | Provider | board_id | Status | Open jobs |
| --- | --- | --- | --- | ---: |
| Coursera | greenhouse | coursera | live complete | 6 |
| Duolingo | greenhouse | duolingo | live complete | 36 |
| Khan Academy | greenhouse | khanacademy | live complete | 1 |
| Instructure | ashby | instructure | live complete | 10 |
| Quizlet | lever | quizlet-2 | failed (lever board quizlet-2 returned 404) | 0 |
| ClassDojo | ashby | classdojo | live complete | 9 |
| Udemy | greenhouse | udemy | live complete | 1 |
| MasterClass | greenhouse | masterclass | live complete | 5 |
| Newsela | greenhouse | newsela | live complete | 9 |
| Outschool | greenhouse | outschool | live complete | 1 |
| Amplify | ashby | amplify | live complete | 28 |
| Degreed | greenhouse | degreed | live complete | 0 |
| DataCamp | greenhouse | datacamp | live complete | 21 |
| Brilliant | lever | brilliant | live complete | 0 |
| Age of Learning | lever | aofl | live complete | 0 |
| Handshake | ashby | handshake | live complete | 55 |
| Babbel | ashby | babbel | live complete | 1 |
| Clever | ashby | clever | failed (ashby board clever returned 404) | 0 |
| Seesaw | greenhouse | seesaw | live complete | 1 |
| Edpuzzle | lever | edpuzzle | live complete | 1 |
| Skillsoft | greenhouse | skillsoft | live complete | 0 |
| GoStudent | greenhouse | gostudent | live complete | 0 |
| GiveCampus | greenhouse | givecampus | live complete | 12 |
| Teachable | greenhouse | teachablecareers | live complete | 2 |
| LearnUpon | greenhouse | learnupon | live complete | 1 |
| MagicSchool AI | ashby | magicschool | live complete | 1 |
| Brisk Teaching | ashby | brisk-teaching | live complete | 1 |

## Open/close snapshot diff

Compared against prior receipts from 2026-09-20T01:39:56.743Z.

- Boards compared: 25
- Jobs opened: 0
- Jobs closed: 0

_No per-board diffs in this comparison window._

## Gaps and growth path

- Pack identities (91) exceed live-complete boards measured here (25); many rows are LastRound-confirmed identities not re-verified in this bounded run.
- Incomplete boards in this run: 2 (quizlet-2, clever).
- Live counts come from `fetchCanonicalBoard`, which keeps US-eligible roles (explicit US location or remote-US/global remote). Non-US-only postings are dropped by the canonical adapter.
- Edtech.com directory employers on unsupported ATS vendors or without public JSON boards are not in this pack.
- Growth path: join the vendored LastRound 9,935-row ATS directory for additional education employers instead of scraping Edtech.com HTML.

Receipts JSON for offline tests: `evals/fixtures/edtech-benchmark/receipts.json`.

