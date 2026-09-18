# Changelog

Notable changes to OH SHI are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Deterministic natural-language job search across the public API and job board.
- A persistent GitHub repository link in the site header.

### Fixed

- Preserve verified job descriptions when later ATS snapshots omit posting bodies.
- Treat duplicate in-progress refresh responses as a bounded replay wait so completed
  scheduled refreshes no longer report false failures.
- Bound each discovery batch so the combined discovery and canonical refresh persists
  its completion receipt within the hosted request window.
- Release unread HTTP response bodies during discovery and canonical retries so the
  Worker cannot exhaust its concurrent fetch slots during scheduled refreshes.
- Run discovery and canonical verification as separate idempotent requests so each
  phase stays within the hosted request deadline as source coverage grows.
- Use the Worker's full six-connection budget for canonical source verification so
  the 440-source pass completes within its independent request window.

## [0.1.0] - 2026-08-07

### Added

- Contributor issue forms, security reporting guidance, and a code of conduct.
- A maintainer release checklist and changelog policy.
- Evidence-first startup hiring board and public company/job pages.
- Public intelligence, compatibility, change, signal, and coverage APIs.
- JSONL bulk exports, daily change exports, and `llms.txt` guidance.
- Canonical ATS ingestion with provenance, completeness checks, quarantine,
  closure guards, and deterministic hiring/evidence scores.
- Cloudflare D1 persistence, scheduled refresh workflows, deterministic
  evaluations, and browser-level accessibility and usability coverage.

### Changed

- Reorganized the README around the product, quick start, public interfaces,
  architecture, and contribution paths.

[Unreleased]: https://github.com/lpbangun/oh-shi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lpbangun/oh-shi/releases/tag/v0.1.0
