import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  companySlugFromDomain,
  resolveDiscoveredCompanySlug,
} from "../lib/discovery-policy";

test("hyphenated ccTLD domains collide under the public company slug alphabet", () => {
  assert.equal(companySlugFromDomain("acme.co.uk"), "acme-co-uk");
  assert.equal(companySlugFromDomain("acme-co.uk"), "acme-co-uk");
  assert.equal(companySlugFromDomain("foo.github.io"), "foo-github-io");
  assert.equal(companySlugFromDomain("foo-github.io"), "foo-github-io");
});

test("a colliding slug is disambiguated instead of reused for a second employer", () => {
  const firstDomain = "acme.co.uk";
  const secondDomain = "acme-co.uk";
  const firstSlug = resolveDiscoveredCompanySlug(firstDomain, null);
  assert.equal(firstSlug, "acme-co-uk");
  assert.equal(
    resolveDiscoveredCompanySlug(firstDomain, { domain: firstDomain }),
    firstSlug,
    "re-activating the same domain must keep its slug"
  );
  const secondSlug = resolveDiscoveredCompanySlug(secondDomain, { domain: firstDomain });
  assert.notEqual(secondSlug, firstSlug);
  assert.match(secondSlug, /^acme-co-uk-[a-z0-9]+$/);
});

test("a colliding slug no longer drops the second company or orphans its source", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "discovery-activation-slug" },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  await database.batch([
    database.prepare(`CREATE TABLE companies (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, domain TEXT NOT NULL
    )`),
    database.prepare(`CREATE TABLE company_sources (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, provider TEXT NOT NULL
    )`),
  ]);

  const firstDomain = "acme.co.uk";
  const secondDomain = "acme-co.uk";
  const collidingSlug = companySlugFromDomain(firstDomain);
  await database.prepare(
    "INSERT INTO companies (id, slug, name, domain) VALUES (?, ?, ?, ?)"
  ).bind("company_first", collidingSlug, "Acme UK", firstDomain).run();

  const ignored = await database.prepare(
    "INSERT OR IGNORE INTO companies (id, slug, name, domain) VALUES (?, ?, ?, ?)"
  ).bind("company_second", collidingSlug, "Acme Co", secondDomain).run();
  assert.equal(Number(ignored.meta.changes || 0), 0, "the unique slug must reject the colliding insert");
  await database.prepare(
    "INSERT OR IGNORE INTO company_sources (id, company_id, provider) VALUES (?, ?, ?)"
  ).bind("ashby:acme-co", "company_second", "ashby").run();
  const orphan = await database.prepare(`SELECT sources.company_id as companyId
    FROM company_sources sources LEFT JOIN companies ON companies.id=sources.company_id
    WHERE sources.id='ashby:acme-co'`).first<{ companyId: string | null }>();
  assert.equal(orphan?.companyId, "company_second");
  const missingCompany = await database.prepare(
    "SELECT id FROM companies WHERE id='company_second'"
  ).first();
  assert.equal(missingCompany, null, "pre-fix INSERT OR IGNORE left a source with no company");

  await database.prepare("DELETE FROM company_sources WHERE id='ashby:acme-co'").run();
  const uniqueSlug = resolveDiscoveredCompanySlug(secondDomain, { domain: firstDomain });
  await database.prepare(
    "INSERT OR IGNORE INTO companies (id, slug, name, domain) VALUES (?, ?, ?, ?)"
  ).bind("company_second", uniqueSlug, "Acme Co", secondDomain).run();
  await database.prepare(`INSERT OR IGNORE INTO company_sources (id, company_id, provider)
    SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM companies WHERE id=?)`)
    .bind("ashby:acme-co", "company_second", "ashby", "company_second").run();

  const companies = await database.prepare(
    "SELECT id, slug, domain FROM companies ORDER BY id"
  ).all<{ id: string; slug: string; domain: string }>();
  assert.deepEqual(companies.results, [
    { id: "company_first", slug: collidingSlug, domain: firstDomain },
    { id: "company_second", slug: uniqueSlug, domain: secondDomain },
  ]);
  const joined = await database.prepare(`SELECT companies.domain as domain
    FROM company_sources sources JOIN companies ON companies.id=sources.company_id
    WHERE sources.id='ashby:acme-co'`).first<{ domain: string }>();
  assert.equal(joined?.domain, secondDomain);
});
