import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import { planDiscoveredCompanyActivation } from "../lib/discovery-policy";

test("a second domain that hits an existing ATS board joins the owner instead of creating a ghost company", () => {
  const owner = "company_acme_com";
  assert.deepEqual(
    planDiscoveredCompanyActivation({
      existingCompanyId: null,
      boardOwnerCompanyId: owner,
      newCompanyId: "company_acme_ai",
    }),
    { companyId: owner, insertCompany: false, insertSource: false }
  );
});

test("a first-time board still creates the company and source", () => {
  assert.deepEqual(
    planDiscoveredCompanyActivation({
      existingCompanyId: null,
      boardOwnerCompanyId: null,
      newCompanyId: "company_acme_com",
    }),
    { companyId: "company_acme_com", insertCompany: true, insertSource: true }
  );
  assert.deepEqual(
    planDiscoveredCompanyActivation({
      existingCompanyId: "company_acme_com",
      boardOwnerCompanyId: null,
      newCompanyId: "company_unused",
    }),
    { companyId: "company_acme_com", insertCompany: false, insertSource: true }
  );
});

test("INSERT OR IGNORE on a shared board used to publish an empty second company", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "discovery-shared-board" },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  await database.batch([
    database.prepare(`CREATE TABLE companies (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, domain TEXT NOT NULL
    )`),
    database.prepare(`CREATE TABLE company_sources (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, provider TEXT NOT NULL,
      board_id TEXT NOT NULL, UNIQUE(provider, board_id)
    )`),
    database.prepare(`CREATE TABLE discovery_queue (
      id TEXT PRIMARY KEY, normalized_domain TEXT NOT NULL UNIQUE, status TEXT NOT NULL
    )`),
    database.prepare(`CREATE TABLE startup_domains (
      canonical_domain TEXT PRIMARY KEY, company_id TEXT
    )`),
  ]);

  await database.batch([
    database.prepare(
      "INSERT INTO companies (id, slug, name, domain) VALUES (?, ?, ?, ?)"
    ).bind("company_acme_com", "acme-com", "Acme", "acme.com"),
    database.prepare(`INSERT INTO company_sources (id, company_id, provider, board_id)
      VALUES (?, ?, ?, ?)`).bind("greenhouse:acme", "company_acme_com", "greenhouse", "acme"),
    database.prepare(
      "INSERT INTO discovery_queue (id, normalized_domain, status) VALUES (?, ?, ?)"
    ).bind("candidate_acme_ai", "acme.ai", "canonical_source_found"),
    database.prepare(
      "INSERT INTO startup_domains (canonical_domain, company_id) VALUES (?, NULL)"
    ).bind("acme.ai"),
  ]);

  const broken = planDiscoveredCompanyActivation({
    existingCompanyId: null,
    boardOwnerCompanyId: null,
    newCompanyId: "company_acme_ai",
  });
  await database.batch([
    database.prepare(
      "INSERT OR IGNORE INTO companies (id, slug, name, domain) VALUES (?, ?, ?, ?)"
    ).bind(broken.companyId, "acme-ai", "Acme AI", "acme.ai"),
    database.prepare(`INSERT OR IGNORE INTO company_sources (id, company_id, provider, board_id)
      VALUES (?, ?, ?, ?)`).bind("greenhouse:acme", broken.companyId, "greenhouse", "acme"),
    database.prepare("UPDATE discovery_queue SET status='active' WHERE id=?")
      .bind("candidate_acme_ai"),
    database.prepare("UPDATE startup_domains SET company_id=? WHERE canonical_domain=?")
      .bind(broken.companyId, "acme.ai"),
  ]);
  const ghost = await database.prepare(
    "SELECT id FROM companies WHERE id=?"
  ).bind("company_acme_ai").first<{ id: string }>();
  const ghostSource = await database.prepare(
    "SELECT company_id as companyId FROM company_sources WHERE company_id=?"
  ).bind("company_acme_ai").first();
  assert.equal(ghost?.id, "company_acme_ai");
  assert.equal(ghostSource, null, "pre-fix INSERT OR IGNORE dropped the second source");

  await database.batch([
    database.prepare("DELETE FROM companies WHERE id='company_acme_ai'"),
    database.prepare("UPDATE discovery_queue SET status='canonical_source_found' WHERE id='candidate_acme_ai'"),
    database.prepare("UPDATE startup_domains SET company_id=NULL WHERE canonical_domain='acme.ai'"),
  ]);

  const boardOwner = await database.prepare(
    "SELECT company_id as companyId FROM company_sources WHERE provider=? AND board_id=?"
  ).bind("greenhouse", "acme").first<{ companyId: string }>();
  const plan = planDiscoveredCompanyActivation({
    existingCompanyId: null,
    boardOwnerCompanyId: boardOwner?.companyId,
    newCompanyId: "company_acme_ai",
  });
  assert.equal(plan.insertCompany, false);
  assert.equal(plan.insertSource, false);
  assert.equal(plan.companyId, "company_acme_com");
  await database.batch([
    database.prepare("UPDATE discovery_queue SET status='active' WHERE id=?")
      .bind("candidate_acme_ai"),
    database.prepare("UPDATE startup_domains SET company_id=? WHERE canonical_domain=?")
      .bind(plan.companyId, "acme.ai"),
  ]);

  const companies = await database.prepare(
    "SELECT id FROM companies ORDER BY id"
  ).all<{ id: string }>();
  assert.deepEqual(companies.results.map((row) => row.id), ["company_acme_com"]);
  const linked = await database.prepare(
    "SELECT company_id as companyId FROM startup_domains WHERE canonical_domain=?"
  ).bind("acme.ai").first<{ companyId: string }>();
  assert.equal(linked?.companyId, "company_acme_com");
  const source = await database.prepare(
    "SELECT company_id as companyId FROM company_sources WHERE provider=? AND board_id=?"
  ).bind("greenhouse", "acme").first<{ companyId: string }>();
  assert.equal(source?.companyId, "company_acme_com");
});
