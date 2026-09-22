# LastRound AI ATS company directory

This directory vendors a snapshot of the [LastRound AI hiring data](https://github.com/fyrosofttech/lastroundai-hiring-data) ATS company directory used to build the Gate 1 edtech employer pack.

## File

- `lastroundai-ats-company-directory-2026-08.csv` — columns: `ats_vendor`, `company_name`, `board_slug`, `last_crawled`

## License

The LastRound AI ATS directory is licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

Suggested attribution:

> ATS company directory data © LastRound AI, used under CC BY 4.0. Source: https://github.com/fyrosofttech/lastroundai-hiring-data

## Usage in OH SHI

`scripts/build-edtech-pack.ts` joins this directory with Wikidata (CC0) website evidence and manual review rules to produce `packs/edtech.json`. The vendored CSV keeps builder output deterministic offline.
