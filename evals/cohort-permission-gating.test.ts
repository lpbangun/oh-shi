import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  COHORT_KEY,
  COHORT_MANIFEST_PATH,
  parseCohortManifest,
  summarizeCohortManifest,
} from "../lib/cohort-manifest";
import {
  COHORT_PERMISSION_BY_ACCESS_MODE,
  COHORT_POC_SOURCE_CLASSIFICATION,
  COHORT_SOURCE_KIND,
  COHORT_STAGED_SOURCE_CLASSIFICATION,
  cohortEvidenceRecords,
} from "../lib/cohort-manifest-import";
import { buildStartupDomainPilot, type StartupDomainEvidenceInput } from "../lib/domain-registry";
import {
  discoveryPermissionSql,
  discoveryPromotionGateSql,
  discoveryPromotionOrderSql,
  discoveryRunnableSql,
  discoverySourceFetchRefusal,
} from "../lib/discovery-policy";
import { summarizeDiscoveryReceipts } from "../lib/refresh-contract";

/**
 * The cohort import writes evidence, not activation. These tests pin the three
 * permission gates that keep `manual_only` and `awaiting_permission` leads out
 * of discovery — the registry's promotion (enqueue) gate, the queue's runnable
 * predicate, and the investor-source fetch refusal — plus the fail-closed rule
 * that a `permitted` row without `source_terms_url` is refused everywhere.
 */

const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), "utf8");

const QUEUE_TABLE = `CREATE TABLE discovery_queue (
  id TEXT PRIMARY KEY, normalized_domain TEXT NOT NULL UNIQUE,
  company_name TEXT, website_url TEXT, status TEXT NOT NULL,
  first_discovered_at TEXT NOT NULL, review_notes TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0, discovery_version TEXT,
  next_attempt_at TEXT, last_attempted_at TEXT, last_outcome TEXT
)`;

const EVIDENCE_TABLE = `CREATE TABLE startup_domain_evidence (
  canonical_domain TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
  source_classification TEXT NOT NULL, evidence_url TEXT NOT NULL,
  permission_status TEXT NOT NULL, source_terms_url TEXT, observed_at TEXT NOT NULL,
  observed_website_urls_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(canonical_domain, source_kind, source_id, evidence_url)
)`;

const DOMAINS_TABLE = `CREATE TABLE startup_domains (
  canonical_domain TEXT PRIMARY KEY, company_id TEXT UNIQUE,
  company_name TEXT NOT NULL, website_url TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending',
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
)`;

const REVIEWS_TABLE = `CREATE TABLE discovery_candidate_reviews (
  candidate_id TEXT NOT NULL, status TEXT NOT NULL
)`;

async function withDatabase(name: string) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: name },
  });
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  return { miniflare, database };
}

test("registry promotion enqueues only domains with permitted evidence", async (t) => {
  const { miniflare, database } = await withDatabase("cohort-promotion-gate");
  t.after(() => miniflare.dispose());
  await database.prepare(DOMAINS_TABLE).run();
  await database.prepare(EVIDENCE_TABLE).run();
  await database.prepare(QUEUE_TABLE).run();
  await database.prepare(REVIEWS_TABLE).run();

  const seenAt = "2026-09-23T09:46:32.671Z";
  const insertDomain = (domain: string, reviewStatus: string, companyId: string | null) =>
    database.prepare(`INSERT INTO startup_domains (canonical_domain, company_id,
      company_name, website_url, review_status, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
      domain, companyId, domain, `https://${domain}`, reviewStatus, seenAt, seenAt
    ).run();
  const insertEvidence = (domain: string, permissionStatus: string) =>
    database.prepare(`INSERT INTO startup_domain_evidence (canonical_domain, source_kind,
      source_id, source_classification, evidence_url, permission_status, source_terms_url,
      observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      domain,
      COHORT_SOURCE_KIND,
      `curated:${domain}`,
      COHORT_POC_SOURCE_CLASSIFICATION,
      `https://${domain}/careers`,
      permissionStatus,
      permissionStatus === "permitted" ? `https://${domain}/terms` : null,
      seenAt
    ).run();

  // One promotable row plus every near-miss the gate has to refuse.
  await insertDomain("permitted-pending.example", "pending", null);
  await insertEvidence("permitted-pending.example", "permitted");
  await insertDomain("manual-only.example", "pending", null);
  await insertEvidence("manual-only.example", "manual_only");
  await insertDomain("awaiting.example", "pending", null);
  await insertEvidence("awaiting.example", "awaiting_permission");
  await insertDomain("permitted-verified.example", "verified", "company_verified");
  await insertEvidence("permitted-verified.example", "permitted");
  await insertDomain("permitted-owned.example", "pending", "company_owned");
  await insertEvidence("permitted-owned.example", "permitted");
  await insertDomain("permitted-queued.example", "pending", null);
  await insertEvidence("permitted-queued.example", "permitted");
  await database.prepare(`INSERT INTO discovery_queue (id, normalized_domain, status,
    first_discovered_at) VALUES ('candidate_queued', 'permitted-queued.example',
    'discovered', ?)`).bind(seenAt).run();

  // The production promotion query: same gate fragment, join, and order the
  // registry promotion uses (see promoteRegistryDomains in lib/discovery.ts).
  const promotionQuery = `SELECT domains.canonical_domain as canonicalDomain,
      domains.company_name as companyName,
      domains.website_url as websiteUrl,
      MAX(CASE WHEN evidence.source_kind=? THEN 1 ELSE 0 END) as directoryRanked
    FROM startup_domains domains
    JOIN startup_domain_evidence evidence
      ON evidence.canonical_domain=domains.canonical_domain
    LEFT JOIN discovery_queue queue
      ON queue.normalized_domain=domains.canonical_domain
    WHERE ${discoveryPromotionGateSql()}
    GROUP BY domains.canonical_domain
    ORDER BY ${discoveryPromotionOrderSql("domains")}
    LIMIT ?`;
  const candidates = await database.prepare(promotionQuery)
    .bind("ycombinator-oss", 150)
    .all<{ canonicalDomain: string; companyName: string; websiteUrl: string }>();
  assert.deepEqual(
    candidates.results.map((row) => row.canonicalDomain),
    ["permitted-pending.example"],
    "only a pending, unowned, never-queued domain with permitted evidence may promote"
  );

  // Enqueue exactly as the promotion does, then prove the refusal.
  await database.batch(candidates.results.map((row) =>
    database.prepare(`INSERT INTO discovery_queue (id, normalized_domain, company_name,
      website_url, status, first_discovered_at, review_notes)
      VALUES (?, ?, ?, ?, 'discovered', ?, 'Promoted from the startup domain registry.')
      ON CONFLICT(normalized_domain) DO NOTHING`).bind(
      `candidate_${row.canonicalDomain}`,
      row.canonicalDomain,
      row.companyName,
      row.websiteUrl,
      seenAt
    )
  ));
  const queued = await database.prepare(
    "SELECT normalized_domain as domain FROM discovery_queue ORDER BY normalized_domain"
  ).all<{ domain: string }>();
  assert.deepEqual(queued.results.map((row) => row.domain), [
    "permitted-pending.example",
    "permitted-queued.example",
  ]);
  const refused = await database.prepare(`SELECT domains.canonical_domain as canonicalDomain
    FROM startup_domains domains
    WHERE EXISTS (SELECT 1 FROM startup_domain_evidence evidence
        WHERE evidence.canonical_domain=domains.canonical_domain
          AND evidence.permission_status IN ('manual_only','awaiting_permission'))
      AND NOT EXISTS (SELECT 1 FROM discovery_queue queue
        WHERE queue.normalized_domain=domains.canonical_domain)
    ORDER BY domains.canonical_domain`).all<{ canonicalDomain: string }>();
  assert.deepEqual(
    refused.results.map((row) => row.canonicalDomain),
    ["awaiting.example", "manual-only.example"],
    "manual_only and awaiting_permission leads are refused enqueue, not deferred"
  );

  // The live violation query (VAL-COH-003): no queued domain may lack permitted evidence.
  const violation = await database.prepare(`SELECT queue.normalized_domain as domain
    FROM discovery_queue queue
    WHERE NOT EXISTS (SELECT 1 FROM startup_domain_evidence evidence
      WHERE evidence.canonical_domain=queue.normalized_domain
        AND evidence.permission_status='permitted')`).all<{ domain: string }>();
  assert.deepEqual(violation.results, []);

  const discovery = await read("lib/discovery.ts");
  assert.match(discovery, /discoveryPromotionGateSql\(\)/);
  assert.match(discovery, /INSERT INTO discovery_queue/);
});

test("runnable predicate refuses queue rows without permitted evidence", async (t) => {
  const { miniflare, database } = await withDatabase("cohort-runnable-gate");
  t.after(() => miniflare.dispose());
  await database.prepare(QUEUE_TABLE).run();
  await database.prepare(EVIDENCE_TABLE).run();
  await database.prepare(REVIEWS_TABLE).run();

  const firstSeen = "2026-09-23T09:00:00.000Z";
  const rows = [
    ["permitted-due", "permitted-due.example", "permitted", null],
    ["permitted-deferred", "permitted-deferred.example", "permitted", "2026-09-24T00:00:00.000Z"],
    ["manual-only", "manual-only.example", "manual_only", null],
    ["awaiting", "awaiting.example", "awaiting_permission", null],
    ["no-evidence", "no-evidence.example", null, null],
  ] as const;
  for (const [id, domain, permissionStatus, nextAttemptAt] of rows) {
    await database.prepare(`INSERT INTO discovery_queue (id, normalized_domain, status,
      first_discovered_at, next_attempt_at, attempt_count)
      VALUES (?, ?, 'discovered', ?, ?, 0)`).bind(
      id, domain, firstSeen, nextAttemptAt
    ).run();
    if (permissionStatus) {
      await database.prepare(`INSERT INTO startup_domain_evidence (canonical_domain,
        source_kind, source_id, source_classification, evidence_url, permission_status,
        source_terms_url, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        domain,
        COHORT_SOURCE_KIND,
        `curated:${domain}`,
        COHORT_STAGED_SOURCE_CLASSIFICATION,
        `https://${domain}/careers`,
        permissionStatus,
        permissionStatus === "permitted" ? `https://${domain}/terms` : null,
        firstSeen
      ).run();
    }
  }

  const bindRunnable = [
    "current-version",
    "2026-09-23T08:00:00.000Z",
    "2026-09-23T12:00:00.000Z",
  ] as const;
  const runnable = await database.prepare(`SELECT q.id FROM discovery_queue q
    WHERE ${discoveryRunnableSql("q")} ORDER BY q.id`).bind(...bindRunnable)
    .all<{ id: string }>();
  assert.deepEqual(
    runnable.results.map((row) => row.id),
    ["permitted-due"],
    "manual_only, awaiting_permission, and evidence-less rows are never processed"
  );

  const permissionSql = discoveryPermissionSql("q");
  const funnel = await database.prepare(`SELECT COUNT(*) as total,
    SUM(CASE WHEN ${permissionSql} THEN 1 ELSE 0 END) as autoEligible,
    SUM(CASE WHEN NOT ${permissionSql} THEN 1 ELSE 0 END) as permissionExcluded
    FROM discovery_queue q`).first<{
      total: number;
      autoEligible: number;
      permissionExcluded: number;
    }>();
  assert.ok(funnel);
  assert.equal(funnel.autoEligible, 2);
  assert.equal(funnel.permissionExcluded, 3);
  assert.equal(funnel.autoEligible + funnel.permissionExcluded, funnel.total);
  assert.ok(runnable.results.length <= funnel.autoEligible);
});

test("sources without public_page access are refused before any fetch or enqueue", async () => {
  assert.equal(discoverySourceFetchRefusal("public_page"), null);
  assert.equal(discoverySourceFetchRefusal("manual_import"), "manual");
  assert.equal(discoverySourceFetchRefusal("awaiting_permission"), "blocked");
  assert.equal(discoverySourceFetchRefusal("prohibited"), "blocked");

  // The refusal must precede the portfolio fetch: a source that is never
  // fetched can never enqueue a candidate, so the leads stay leads.
  const discovery = await read("lib/discovery.ts");
  const refusalAt = discovery.indexOf("discoverySourceFetchRefusal(source.accessMode)");
  const fetchAt = discovery.indexOf("permittedFetch(source.portfolioUrl");
  assert.ok(refusalAt >= 0, "the discovery source path must refuse non-public_page access");
  assert.ok(fetchAt > refusalAt, "the fetch must sit behind the refusal");

  // The refusal is reported honestly rather than fetched: manual and blocked
  // sources are counted, never treated as discovered.
  const counts = summarizeDiscoveryReceipts([
    { source_id: "manual", access_mode: "manual_import", status: "manual", fetched: false, discovered_count: 0 },
    { source_id: "blocked", access_mode: "awaiting_permission", status: "blocked", fetched: false, discovered_count: 0 },
    { source_id: "live", access_mode: "public_page", status: "completed", fetched: true, discovered_count: 2 },
  ]);
  assert.equal(counts.manual, 1);
  assert.equal(counts.blocked, 1);
  assert.equal(counts.fetched, 1);
  assert.equal(counts.reconciled, true);
});

test("permitted without source terms is fail-closed at the registry and at import", async () => {
  const permitted: StartupDomainEvidenceInput = {
    companyName: "Example Health",
    websiteUrl: "https://examplehealth.example/",
    sourceId: "curated:examplehealth",
    sourceKind: COHORT_SOURCE_KIND,
    sourceClassification: COHORT_POC_SOURCE_CLASSIFICATION,
    evidenceUrl: "https://examplehealth.example/careers",
    permissionStatus: "permitted",
    observedAt: "2026-09-23T09:46:32.671Z",
  };
  const refused = buildStartupDomainPilot([permitted], 1, COHORT_KEY);
  assert.equal(refused.entries.length, 0);
  assert.equal(refused.receipt.rejectedRecords, 1);
  assert.equal(refused.receipt.validRecords, 0);

  const accepted = buildStartupDomainPilot(
    [{ ...permitted, sourceTermsUrl: "https://examplehealth.example/terms" }],
    1,
    COHORT_KEY
  );
  assert.equal(accepted.receipt.rejectedRecords, 0);
  assert.equal(accepted.entries.length, 1);
  assert.equal(accepted.entries[0].evidence[0].permissionStatus, "permitted");
  assert.equal(
    accepted.entries[0].evidence[0].sourceTermsUrl,
    "https://examplehealth.example/terms"
  );

  // Non-permitted lead states may omit terms; the rule bites only the claim of
  // automated permission.
  const manual = buildStartupDomainPilot(
    [{ ...permitted, permissionStatus: "manual_only" as const }],
    1,
    COHORT_KEY
  );
  assert.equal(manual.receipt.rejectedRecords, 0);
  assert.equal(manual.entries[0].evidence[0].permissionStatus, "manual_only");

  // The import mapper drops such a row instead of sending a batch it would lose.
  const row = {
    name: "Example Health",
    website_url: "https://examplehealth.example/",
    domain: "examplehealth.example",
    sector: "Healthcare",
    ats_hint: "ashby" as const,
    careers_url: "https://jobs.ashbyhq.com/examplehealth",
    access_mode: "public_page" as const,
    terms_url: "",
    evidence_url: "https://jobs.ashbyhq.com/examplehealth",
    notes: "general:v1 POC seed; probe receipt evidence/cohorts/probes/ashby-examplehealth.json",
  };
  const mapped = cohortEvidenceRecords([row], "2026-09-23T09:46:32.671Z");
  assert.equal(mapped.records.length, 0);
  assert.deepEqual(mapped.drops.map((drop) => drop.reason), [
    "permitted_requires_source_terms",
  ]);
  const withTerms = cohortEvidenceRecords(
    [{ ...row, terms_url: "https://www.ashbyhq.com/terms" }],
    "2026-09-23T09:46:32.671Z"
  );
  assert.equal(withTerms.drops.length, 0);
  assert.equal(withTerms.records.length, 1);
  assert.equal(withTerms.records[0].permissionStatus, "permitted");
  assert.equal(withTerms.records[0].sourceTermsUrl, "https://www.ashbyhq.com/terms");

  // The import endpoint applies the same rule before persisting anything.
  const route = await read("app/api/internal/discovery/domains/route.ts");
  assert.match(
    route,
    /permissionStatus === "permitted" && !string\(raw\.sourceTermsUrl\)/
  );
});

test("the general:v1 manifest imports as evidence with honest permission classes", async () => {
  const manifestText = await readFile(path.join(root, COHORT_MANIFEST_PATH), "utf8");
  const { rows, issues } = parseCohortManifest(manifestText);
  assert.deepEqual(issues, []);
  assert.equal(rows.length, 1_037, "the import target is the manifest the receipt records");

  const summary = summarizeCohortManifest(rows);
  const observedAt = "2026-09-23T09:46:32.671Z";
  const { records, drops } = cohortEvidenceRecords(rows, observedAt);
  assert.deepEqual(drops, [], "no manifest row may fail the registry contract");
  assert.equal(records.length, rows.length);

  assert.equal(COHORT_PERMISSION_BY_ACCESS_MODE.public_page, "permitted");
  assert.equal(COHORT_PERMISSION_BY_ACCESS_MODE.manual_import, "manual_only");
  assert.equal(COHORT_PERMISSION_BY_ACCESS_MODE.awaiting_permission, "awaiting_permission");

  const byWebsite = new Map(records.map((record) => [record.websiteUrl, record]));
  for (const row of rows) {
    const record = byWebsite.get(row.website_url);
    assert.ok(record, `${row.domain} must map to a record`);
    assert.equal(record.sourceKind, COHORT_SOURCE_KIND);
    assert.equal(record.evidenceUrl, row.evidence_url);
    assert.equal(record.sourceTermsUrl, row.terms_url);
    assert.equal(
      record.permissionStatus,
      COHORT_PERMISSION_BY_ACCESS_MODE[row.access_mode],
      `${row.domain} permission status must be derived from its access mode`
    );
    if (row.access_mode === "public_page") {
      assert.equal(record.sourceClassification, COHORT_POC_SOURCE_CLASSIFICATION);
      assert.match(record.sourceId, /^curated:/);
      assert.equal(record.permissionStatus, "permitted");
      assert.ok(record.sourceTermsUrl, "permitted rows always carry source terms");
    } else {
      assert.equal(record.sourceClassification, COHORT_STAGED_SOURCE_CLASSIFICATION);
      assert.match(record.sourceId, /^wikidata:Q\d+$/);
      assert.ok(
        record.permissionStatus === "manual_only" ||
          record.permissionStatus === "awaiting_permission"
      );
    }
  }
  assert.equal(
    records.filter((record) => record.permissionStatus === "permitted").length,
    summary.byAccessMode.public_page
  );
  assert.equal(
    records.filter((record) => record.permissionStatus === "awaiting_permission").length,
    summary.byAccessMode.awaiting_permission
  );

  // Dry-run of what the import posts: the batch the endpoint would receive
  // reconciles with no rejected records and no identity conflicts.
  const pilot = buildStartupDomainPilot(records, records.length, COHORT_KEY);
  assert.equal(pilot.receipt.rejectedRecords, 0);
  assert.equal(pilot.receipt.duplicateDomains, 0);
  assert.equal(pilot.receipt.truncatedDomains, 0);
  assert.equal(pilot.receipt.accepted, records.length);
  assert.equal(pilot.receipt.identityGraphValid, true);
  assert.equal(pilot.entries.length, records.length);
});
