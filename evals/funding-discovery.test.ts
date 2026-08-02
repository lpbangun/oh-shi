import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  fundingDiscoveryFromPage,
  fundingLinksFromHtml,
  pageMetadata,
} from "../lib/funding-discovery";
import { fundingMovements } from "../lib/derive";
import { persistFundingDiscoveryRecords } from "../lib/funding-store";
import { seedCompanies } from "../lib/seed";

const company = seedCompanies.find((item) => item.id === "company_higharc")!;
const NOW = "2026-08-02T12:00:00.000Z";

test("funding pages convert into source-cited, company-scored movements", () => {
  const html = `
    <html><head>
      <meta property="og:title" content="Higharc raises $120M Series D to expand homebuilding AI">
      <meta property="og:description" content="Higharc announced new financing for its next stage of growth.">
      <meta property="article:published_time" content="2026-08-01T14:30:00Z">
    </head></html>`;
  const metadata = pageMetadata(html);
  const discovery = fundingDiscoveryFromPage({
    company,
    sourceUrl: "https://techcrunch.com/2026/08/01/higharc-raises-series-d/",
    sourceKind: "reputable",
    publisher: "TechCrunch",
    metadata,
    now: NOW,
  });
  assert.ok(discovery);
  assert.equal(discovery.latestFundingLabel, "$120M Series D");
  assert.equal(discovery.stage, "Series D");
  assert.match(discovery.sourceUrl, /^https:\/\/techcrunch\.com\//);

  const updatedCompany = {
    ...company,
    latestFundingLabel: discovery.latestFundingLabel,
    latestFundingDate: discovery.occurredAt.slice(0, 10),
    stage: discovery.stage || company.stage,
  };
  const movement = fundingMovements([updatedCompany], [{
    id: discovery.id,
    entityType: "company",
    entityId: discovery.companyId,
    changeType: "funding_announced",
    title: discovery.title,
    description: discovery.description,
    occurredAt: discovery.occurredAt,
    sourceUrl: discovery.sourceUrl,
  }])[0];
  assert.equal(movement.type, "funding");
  assert.equal(movement.hiringScore, company.hiringScore);
  assert.deepEqual(movement.sourceUrls, [discovery.sourceUrl]);
  assert.equal(movement.href, "/company/higharc");
});

test("discovery rejects speculative, stale, and uncited funding claims", () => {
  const base = {
    company,
    sourceUrl: "https://techcrunch.com/higharc-funding/",
    sourceKind: "reputable" as const,
    publisher: "TechCrunch",
    now: NOW,
  };
  assert.equal(fundingDiscoveryFromPage({
    ...base,
    metadata: {
      title: "Higharc in talks to raise $120M",
      description: "The company is seeking new capital.",
      publishedAt: "2026-08-01T00:00:00.000Z",
    },
  }), null);
  assert.equal(fundingDiscoveryFromPage({
    ...base,
    sourceKind: "official",
    metadata: {
      title: "Higharc raised $120M Series D",
      description: "Higharc announced financing.",
      publishedAt: "2026-08-01T00:00:00.000Z",
    },
  }), null, "an external publication cannot be mislabeled as an official company source");
  assert.equal(fundingDiscoveryFromPage({
    ...base,
    metadata: {
      title: "Higharc raised $120M Series D",
      description: "Financing announced.",
      publishedAt: "2026-01-01T00:00:00.000Z",
    },
  }), null);
  assert.equal(fundingDiscoveryFromPage({
    ...base,
    metadata: {
      title: "Higharc raised $120M Series D",
      description: "Financing announced.",
      publishedAt: null,
    },
  }), null);
});

test("funding landing pages yield only definitive HTTPS announcement links", () => {
  const links = fundingLinksFromHtml(`
    <a href="/real">Higharc raises $120M Series D</a>
    <a href="/rumor">Higharc in talks to raise $200M</a>
    <a href="http://example.com/insecure">Acme raises $2M seed</a>
    <a href="/unrelated">How to raise a fund</a>
  `, "https://techcrunch.com/venture/");
  assert.deepEqual(links, [{
    url: "https://techcrunch.com/real",
    label: "Higharc raises $120M Series D",
  }]);
});

test("D1 funding persistence is idempotent and never rolls company facts backward", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "funding-discovery-integration" },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  await database.prepare(`CREATE TABLE companies (
    id TEXT PRIMARY KEY, latest_funding_label TEXT NOT NULL,
    latest_funding_date TEXT, stage TEXT NOT NULL, funding_mode TEXT NOT NULL
  )`).run();
  await database.prepare(`CREATE TABLE changes (
    id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    change_type TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
    occurred_at TEXT NOT NULL, source_url TEXT NOT NULL
  )`).run();
  await database.prepare(`INSERT INTO companies
    (id, latest_funding_label, latest_funding_date, stage, funding_mode)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(company.id, "$95M Series C", "2026-06-30", "Series C", "Venture-backed")
    .run();

  const fresh = fundingDiscoveryFromPage({
    company,
    sourceUrl: "https://techcrunch.com/2026/08/01/higharc-raises-series-d/",
    sourceKind: "reputable",
    publisher: "TechCrunch",
    metadata: {
      title: "Higharc raises $120M Series D",
      description: "Higharc secured fresh financing.",
      publishedAt: "2026-08-01T14:30:00Z",
    },
    now: NOW,
  })!;
  const first = await persistFundingDiscoveryRecords(database, [fresh]);
  const replay = await persistFundingDiscoveryRecords(database, [fresh]);
  assert.deepEqual(
    { added: first.announcementsAdded, updated: first.companiesUpdated },
    { added: 1, updated: 1 }
  );
  assert.deepEqual(
    { added: replay.announcementsAdded, updated: replay.companiesUpdated },
    { added: 0, updated: 0 }
  );
  const stored = await database.prepare(`SELECT latest_funding_label AS label,
    latest_funding_date AS date, stage FROM companies WHERE id=?`)
    .bind(company.id).first<{ label: string; date: string; stage: string }>();
  assert.deepEqual(stored, { label: "$120M Series D", date: "2026-08-01", stage: "Series D" });
  const change = await database.prepare(
    "SELECT source_url AS sourceUrl FROM changes WHERE id=?"
  ).bind(fresh.id).first<{ sourceUrl: string }>();
  assert.equal(change?.sourceUrl, fresh.sourceUrl);
});
