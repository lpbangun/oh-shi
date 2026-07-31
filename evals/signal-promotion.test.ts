import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import type { NormalizedJob } from "../lib/ats-adapters";
import {
  findExactPromotionJob,
  hasEligibleOffBoardEvidence,
  promoteHiringSignal,
  promotionTargetUrls,
} from "../lib/signal-promotion";
import { listOffBoardVerifiedOpeningRecords } from "../lib/signal-store";

const canonicalJob: NormalizedJob = {
  externalId: "ROLE42",
  title: "Platform Engineer",
  roleFamily: "Engineering",
  location: "Remote - US",
  remoteStatus: "Remote",
  employmentType: "Full-time",
  compensation: "See posting",
  canonicalUrl: "https://apply.workable.com/j/ROLE42/",
  publishedAt: "2026-07-20T00:00:00.000Z",
  summary: "Build reliable infrastructure for a growing payments platform.",
};

const signalUrls = {
  sourceUrl: "https://acme.example/blog/platform-team",
  evidenceUrl: "https://acme.example/blog/platform-team",
  applicationUrl: "https://apply.workable.com/j/ROLE42/apply?utm_source=blog",
};

test("promotion matching requires one exact canonical role URL", () => {
  assert.ok(
    promotionTargetUrls(signalUrls).has("https://apply.workable.com/j/ROLE42")
  );
  assert.equal(
    findExactPromotionJob(signalUrls, [canonicalJob])?.externalId,
    "ROLE42"
  );
  assert.equal(
    findExactPromotionJob(
      { ...signalUrls, applicationUrl: "https://apply.workable.com/j/OTHER/apply" },
      [canonicalJob]
    ),
    null
  );
  assert.equal(
    findExactPromotionJob(signalUrls, [
      canonicalJob,
      { ...canonicalJob, externalId: "ROLE43" },
    ]),
    null,
    "ambiguous exact matches fail closed"
  );
});

test("off-board evidence source kinds have enforceable host and permission rules", () => {
  const base = {
    companyDomain: "acme.example",
    sourceKind: "company_blog" as const,
    sourceUrl: "https://acme.example/blog/platform-team",
    evidenceUrl: "https://acme.example/blog/platform-team",
    permissionStatus: "permitted" as const,
  };
  assert.equal(hasEligibleOffBoardEvidence(base), true);
  assert.equal(
    hasEligibleOffBoardEvidence({
      ...base,
      evidenceUrl: "https://jobs.example.net/acme/ROLE42",
    }),
    false
  );
  assert.equal(
    hasEligibleOffBoardEvidence({
      ...base,
      sourceKind: "github",
      sourceUrl: "https://github.com/acme/jobs",
      evidenceUrl: "https://github.com/acme/jobs/issues/42",
    }),
    true
  );
  assert.equal(
    hasEligibleOffBoardEvidence({
      ...base,
      sourceKind: "authorized_api",
    }),
    false
  );
  assert.equal(
    hasEligibleOffBoardEvidence({
      ...base,
      sourceKind: "authorized_api",
      permissionStatus: "authorized",
    }),
    true
  );
});

test("promotion re-verifies, records provenance, rejects mismatch, and replays safely", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "signal-promotion" },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  await database.batch([
    database.prepare(`CREATE TABLE companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT NOT NULL
    )`),
    database.prepare(`CREATE TABLE company_sources (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, provider TEXT NOT NULL,
      board_id TEXT NOT NULL, enabled INTEGER NOT NULL,
      discovery_status TEXT NOT NULL
    )`),
    database.prepare(`CREATE TABLE jobs (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, title TEXT NOT NULL,
      location TEXT NOT NULL, employment_type TEXT NOT NULL,
      canonical_url TEXT NOT NULL, status TEXT NOT NULL
    )`),
    database.prepare(`CREATE TABLE job_observations (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, provider TEXT NOT NULL,
      source_id TEXT NOT NULL, external_id TEXT NOT NULL, status TEXT NOT NULL
    )`),
    database.prepare(`CREATE TABLE hiring_signals (
      id TEXT PRIMARY KEY, company_id TEXT, company_name TEXT NOT NULL,
      company_domain TEXT NOT NULL, role_function TEXT NOT NULL,
      summary TEXT NOT NULL, source_kind TEXT NOT NULL, source_url TEXT NOT NULL,
      evidence_url TEXT NOT NULL, source_rights_url TEXT NOT NULL,
      application_url TEXT, permission_status TEXT NOT NULL,
      confidence INTEGER NOT NULL, status TEXT NOT NULL,
      observed_at TEXT NOT NULL, last_verified_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, promoted_job_id TEXT
    )`),
    database.prepare(`CREATE TABLE hiring_signal_promotions (
      signal_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, company_id TEXT NOT NULL,
      provider TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
      canonical_url TEXT NOT NULL, evidence_url TEXT NOT NULL,
      source_rights_url TEXT NOT NULL, discovery_source_kind TEXT NOT NULL,
      verified_at TEXT NOT NULL, run_id TEXT NOT NULL
    )`),
    database.prepare(
      "INSERT INTO companies (id, name, domain) VALUES ('company-acme', 'Acme', 'acme.example')"
    ),
    database.prepare(`INSERT INTO company_sources (
      id, company_id, provider, board_id, enabled, discovery_status
    ) VALUES (
      'workable:acme', 'company-acme', 'workable', 'acme', 1, 'active'
    )`),
  ]);
  const insertSignal = async (
    id: string,
    applicationUrl: string,
    expiresAt = "2026-08-30T00:00:00.000Z"
  ) => database.prepare(`INSERT INTO hiring_signals (
    id, company_id, company_name, company_domain, role_function, summary,
    source_kind, source_url, evidence_url, source_rights_url, application_url,
    permission_status, confidence, status, observed_at, last_verified_at,
    expires_at, promoted_job_id
  ) VALUES (?, 'company-acme', 'Acme', 'acme.example', 'Platform Engineer',
    'Acme is hiring a platform engineer.', 'company_blog',
    'https://acme.example/blog/platform-team',
    'https://acme.example/blog/platform-team',
    'https://acme.example/terms', ?, 'permitted', 90, 'active',
    '2026-07-20T00:00:00.000Z', '2026-07-30T00:00:00.000Z', ?, NULL)`)
    .bind(id, applicationUrl, expiresAt)
    .run();
  await insertSignal("signal-match", signalUrls.applicationUrl);
  await insertSignal(
    "signal-mismatch",
    "https://apply.workable.com/j/OTHER/apply"
  );
  await insertSignal(
    "signal-expired",
    signalUrls.applicationUrl,
    "2026-07-30T00:00:00.000Z"
  );

  let fetches = 0;
  let persists = 0;
  const fetchSource = async () => {
    fetches += 1;
    return { complete: true as const, jobs: [canonicalJob] };
  };
  const persistSource = async (
    db: D1Database,
    source: {
      id: string;
      companyId: string;
      provider: "workable";
      boardId: string;
    }
  ) => {
    persists += 1;
    await db.batch([
      db.prepare(`INSERT OR REPLACE INTO jobs (
        id, company_id, title, location, employment_type, canonical_url, status
      ) VALUES (
        'job-role42', 'company-acme', 'Platform Engineer', 'Remote - US',
        'Full-time', 'https://apply.workable.com/j/ROLE42/', 'verified_open'
      )`),
      db.prepare(`INSERT OR REPLACE INTO job_observations (
        id, job_id, provider, source_id, external_id, status
      ) VALUES (
        'observation-role42', 'job-role42', ?, ?, 'ROLE42', 'verified_open'
      )`).bind(source.provider, source.id),
    ]);
    return {
      sourceId: source.id,
      companyId: source.companyId,
      provider: source.provider,
      status: "success" as const,
      observed: 1,
      verified: 1,
      opened: 1,
      closed: 0,
    };
  };
  const options = {
    now: "2026-07-31T00:00:00.000Z",
    runId: "promotion-run",
    fetchSource,
    persistSource: persistSource as NonNullable<
      NonNullable<Parameters<typeof promoteHiringSignal>[2]>["persistSource"]
    >,
  };
  const promoted = await promoteHiringSignal(
    database,
    "signal-match",
    options
  );
  assert.deepEqual(promoted, {
    status: "promoted",
    signalId: "signal-match",
    jobId: "job-role42",
    verifiedSources: 1,
    reason: null,
  });
  assert.equal(fetches, 1);
  assert.equal(persists, 1);
  assert.deepEqual(
    await database.prepare(`SELECT status, promoted_job_id AS promotedJobId
      FROM hiring_signals WHERE id='signal-match'`).first(),
    { status: "promoted", promotedJobId: "job-role42" }
  );
  assert.deepEqual(
    await database.prepare(`SELECT job_id AS jobId, evidence_url AS evidenceUrl,
      source_rights_url AS sourceRightsUrl,
      discovery_source_kind AS discoverySourceKind
      FROM hiring_signal_promotions WHERE signal_id='signal-match'`).first(),
    {
      jobId: "job-role42",
      evidenceUrl: "https://acme.example/blog/platform-team",
      sourceRightsUrl: "https://acme.example/terms",
      discoverySourceKind: "company_blog",
    }
  );

  const replay = await promoteHiringSignal(database, "signal-match", options);
  assert.equal(replay.status, "already_promoted");
  assert.equal(fetches, 1);
  assert.equal(persists, 1);
  assert.equal(
    (await promoteHiringSignal(database, "signal-mismatch", options)).reason,
    "exact_current_role_not_found"
  );
  assert.equal(
    (await promoteHiringSignal(database, "signal-expired", options)).reason,
    "signal_inactive_or_expired"
  );
  assert.equal(persists, 1);
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM hiring_signal_promotions"
    ).first<{ count: number }>())?.count),
    1
  );
  assert.deepEqual(await listOffBoardVerifiedOpeningRecords(database), [{
    signalId: "signal-match",
    jobId: "job-role42",
    companyId: "company-acme",
    companyName: "Acme",
    companyDomain: "acme.example",
    title: "Platform Engineer",
    location: "Remote - US",
    employmentType: "Full-time",
    canonicalUrl: "https://apply.workable.com/j/ROLE42/",
    evidenceUrl: "https://acme.example/blog/platform-team",
    sourceRightsUrl: "https://acme.example/terms",
    discoverySourceKind: "company_blog",
    verifiedAt: "2026-07-31T00:00:00.000Z",
  }]);
  await database.prepare(
    "UPDATE jobs SET status='verified_closed' WHERE id='job-role42'"
  ).run();
  assert.deepEqual(await listOffBoardVerifiedOpeningRecords(database), []);
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM hiring_signal_promotions"
    ).first<{ count: number }>())?.count),
    1,
    "closure hides the opening but retains discovery provenance"
  );
});
