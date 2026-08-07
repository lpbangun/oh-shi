# Release guide

This checklist is for maintainers preparing a tagged OH SHI release. Releases
use semantic versions such as `v0.1.0`; the package version omits the `v`.

## 1. Prepare

- Confirm the intended changes are on the default branch and CI is green.
- Review dependency changes and run `pnpm audit --prod --audit-level high`.
- Move relevant entries from `Unreleased` in `CHANGELOG.md` into a dated release
  section and update its comparison links.
- Update `package.json` only when the release version changes, then regenerate
  `pnpm-lock.yaml` with `pnpm install --lockfile-only`.
- Confirm new environment variables, protected routes, migrations, and public
  API behavior are documented.
- Review new or changed external sources against `docs/discovery-sources.md`.

## 2. Verify from a clean checkout

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm e2e:install
pnpm audit --prod --audit-level high
pnpm quality:ci
```

Also inspect the README links and image, the first viewport at desktop and
320px width, and the public API examples against the release candidate.

## 3. Deploy safely

1. Preserve the existing Cloudflare Sites project and D1 binding named `DB`.
2. Confirm the deployment secret `INGEST_TOKEN`, repository variable
   `OH_SHI_BASE_URL`, and GitHub Actions secret `OH_SHI_INGEST_TOKEN` exist.
3. Review every migration since the last release. Migrations must be additive
   and forward-only; never replace or recreate the production D1 database.
4. Deploy the exact reviewed source revision.
5. Check `/api/v1/coverage` and confirm existing company and job counts remain
   present.
6. Smoke-test the homepage, one company page, one job page,
   `/api/v1/intelligence`, `/exports/jobs.jsonl`, and `/llms.txt`.
7. Trigger one canonical refresh and inspect its freshness receipt. Treat any
   mass-removal quarantine as read-only until separately reviewed.

## 4. Publish the GitHub release

- Create the signed or annotated tag `vX.Y.Z` from the deployed commit.
- Title the GitHub release `OH SHI vX.Y.Z`.
- Use the matching changelog section as the release notes, emphasizing user,
  API, data-contract, and operator impact.
- Link migrations or manual operator steps explicitly.
- Mark a release as a pre-release when compatibility or migration behavior is
  still being validated.

## 5. Post-release checks

- Confirm the tag and production deployment resolve to the same commit.
- Watch the CI, refresh, and funding workflows through their next runs.
- Recheck coverage and freshness after the first scheduled refresh.
- File follow-up issues for deferred work rather than silently expanding the
  released scope.

## Rollback

Roll back application code to the previous known-good source revision while
preserving the current D1 binding. Do not reverse a migration by dropping data.
If a new read path is incompatible with stored data, disable or guard that path,
ship a forward fix, and document the incident in the next changelog entry.
