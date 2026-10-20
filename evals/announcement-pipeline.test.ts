import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { announcementSources, type AnnouncementCapture, type AnnouncementInput } from "../lib/daily-engine/announcements";
import { runEngine } from "../lib/daily-engine/engine";
import { openLocalStore } from "../lib/daily-engine/local";
import { listDailyCompanies, readRecords } from "../lib/daily-engine/persist";
import { announcementCli, ANNOUNCEMENT_SCHEDULE } from "../lib/daily-engine/announcement-cli";
import { discoveryEvidenceByCompany } from "../lib/daily-engine/public-evidence";

const now = "2026-10-20T00:00:00.000Z";
const base = { lane: "direct" as const, baseline: { composition: { productionEmployerDomains: [], repoSeedCompanyDomains: [] } }, inputId: "synthetic-announcements", revision: "test", now, fixtures: true };
function policy(url: string, passage: string) {
  const body = `<p>${passage}</p>`;
  return { url, status: 200, body, capturedAt: "2026-10-19T23:00:00.000Z", sha256: createHash("sha256").update(body).digest("hex") };
}
function factualPermission(): AnnouncementCapture["permission"] {
  const evidenceUrl = "https://www.copyright.gov/help/faq/faq-protect.html";
  const passage = "Copyright does not protect facts, ideas, systems, or methods of operation, although it may protect the way these things are expressed.";
  return { status: "permitted", basis: "factual_extraction", scope: "facts_only", evidenceUrl, passage, evidenceCapture: policy(evidenceUrl, passage) };
}
function capture(url: string, body: string): AnnouncementCapture {
  const evidenceUrl = new URL("/reuse-policy", url).href;
  const passage = "Synthetic fixture owner authorizes reuse for testing.";
  return { url, status: 200, contentType: "text/html", body, capturedAt: "2026-10-19T23:00:00.000Z", sha256: createHash("sha256").update(body).digest("hex"), permission: { status: "permitted", basis: "owner_authorization", evidenceUrl, passage, evidenceCapture: policy(evidenceUrl, passage) } };
}
function input(date = "2026-10-18", title = "Acme Raises $8 Million in Seed Funding", hq = "Acme is headquartered in Austin, United States."): AnnouncementInput {
  return { schema: "ohshi-announcement-input/1", announcements: [{ id: "acme-seed", companyName: "Acme", websiteUrl: "https://acme.example", announcement: capture("https://acme.example/news/seed", `<title>${title}</title>${date ? `<meta property="article:published_time" content="${date}">` : ""}<p>Acme raised $8 million in a seed funding round.</p>`), headquarters: [capture("https://acme.example/about", `<p>${hq}</p>`)] }] };
}
async function dry(value: AnnouncementInput, extra = {}) { return runEngine({ ...base, sources: announcementSources(value), dryRun: true, ...extra }); }

test("announcement: independent HQ, no jobs, distinct dates, real local D1 and replay", async t => {
  const store = await openLocalStore(); t.after(() => store.close());
  const value = input();
  const result = await runEngine({ ...base, sources: announcementSources(value), db: store.db });
  assert.equal(result.records.length, 1);
  assert.equal(result.persistence.companiesAdded, 1);
  assert.equal(result.persistence.eventsAdded, 1);
  const record = result.records[0];
  assert.equal(record.isNewCompany, true);
  assert.equal(record.company.openJobCount, 0);
  assert.equal(record.company.hqEvidenceUrl, "https://acme.example/about");
  assert.equal(record.company.discoveredAt, value.announcements[0].announcement.capturedAt);
  assert.ok(record.company.indexedAt);
  assert.equal(record.fundingEvents[0].occurredAt, "2026-10-18T00:00:00.000Z");
  assert.equal(record.fundingEvents[0].discoveredAt, value.announcements[0].announcement.capturedAt);
  const before = await readRecords(store.db);
  const replay = await runEngine({ ...base, sources: announcementSources(value), db: store.db });
  assert.equal(replay.persistence.eventsAdded, 0); assert.equal(replay.persistence.companiesAdded, 0);
  assert.deepEqual(await readRecords(store.db), before);
  assert.equal((await listDailyCompanies(store.db)).length, 1);
  const publicEvidence = (await discoveryEvidenceByCompany(store.db)).get(record.company.id)!;
  assert.equal(publicEvidence.firstSeenAt, record.company.discoveredAt);
  assert.equal(publicEvidence.headquarters.evidenceUrl, "https://acme.example/about");
  assert.equal(publicEvidence.headquarters.capture!.sha256, value.announcements[0].headquarters[0].sha256);
  assert.equal(publicEvidence.fundingEvents[0].occurredAt, "2026-10-18T00:00:00.000Z");
  const later = input("2026-10-19", "Acme Closes Series A Funding");
  later.announcements[0].id = "acme-series-a";
  later.announcements[0].announcement.url = "https://acme.example/news/series-a";
  const update = await runEngine({ ...base, inputId: "second-event", sources: announcementSources(later), db: store.db });
  assert.equal(update.persistence.companiesAdded, 0); assert.equal(update.persistence.eventsAdded, 1);
  assert.equal(update.records[0].isNewCompany, false);
  assert.equal(update.counts.verifiedFundingEventsExistingCompanies, 1);
  assert.equal(update.records[0].fundingEvents.length, 2);
  assert.equal(update.records[0].company.discoveredAt, record.company.discoveredAt);
});

test("announcement: stale, future, undated, conflicting and invalid date never publish", async () => {
  for (const date of ["2026-10-01", "2026-10-21", "", "invalid"]) {
    const result = await dry(input(date));
    assert.equal(result.records.length, 0); assert.equal(result.sourceReceipts[0].status, "failed");
  }
  const value = input();
  value.announcements[0].announcement = capture(value.announcements[0].announcement.url, value.announcements[0].announcement.body + '<script type="application/ld+json">{"datePublished":"2026-10-17"}</script>');
  assert.match((await dry(value)).sourceReceipts[0].error!, /date_conflict/);
  assert.equal((await dry(input(), { lookbackDays: 1 })).records.length, 0);
});

test("announcement: publisher is not company; wrong website, subject and absent binding rejected", async () => {
  const value = input();
  value.announcements[0].announcement = capture("https://news.crunchbase.com/acme-seed", value.announcements[0].announcement.body);
  assert.match((await dry(value)).sourceReceipts[0].error!, /official_domain_not_evidenced/);
  const doc = value.announcements[0].announcement;
  value.announcements[0].announcement = capture(doc.url, doc.body + '<a href="https://acme.example">Acme</a>');
  assert.equal((await dry(value)).records[0].company.domain, "acme.example");
  value.announcements[0].websiteUrl = "https://news.crunchbase.com";
  assert.equal((await dry(value)).records.length, 0);
  assert.equal((await dry(input("2026-10-18", "Another Raises Seed Funding"))).records.length, 0);
});

test("announcement: unknown, offices-only, foreign and contradictory HQ rejected", async () => {
  for (const hq of ["Acme has US customers.", "Acme has an office in Boston, United States.", "Headquartered in Toronto, Canada.", "Headquartered in Austin, United States. Headquartered in Toronto, Canada.", "Not headquartered in Austin, United States."]) {
    assert.equal((await dry(input("2026-10-18", undefined, hq))).records.length, 0, hq);
  }
  const missing = input(); missing.announcements[0].headquarters = [];
  assert.equal((await dry(missing)).records.length, 0);
  const mismatch = input(); mismatch.announcements[0].headquarters[0].url = "https://publisher.example/about";
  assert.equal((await dry(mismatch)).records.length, 0);
  const conflicting = input(); conflicting.announcements[0].headquarters.push(capture("https://acme.example/contact", "Headquartered in Toronto, Canada."));
  assert.equal((await dry(conflicting)).records.length, 0);
  const unsupported = input(); unsupported.announcements[0].headquarters.push(capture("https://acme.example/contact", "Headquartered in London."));
  assert.equal((await dry(unsupported)).records.length, 0);
});

test("announcement: malformed, blocked, tampered and robots-only reuse fail closed", async () => {
  const blocked = input(); blocked.announcements[0].announcement.permission.status = "blocked";
  assert.equal((await dry(blocked)).sourceReceipts[0].status, "blocked");
  for (const mode of ["hash", "http", "type", "robots", "basis", "wall", "sensitive-url", "missing-grant-evidence", "tampered-grant-evidence"]) {
    const value = input(), doc = value.announcements[0].announcement;
    if (mode === "hash") doc.body += "tamper";
    if (mode === "http") doc.status = 403;
    if (mode === "type") doc.contentType = "application/json";
    if (mode === "robots") doc.permission.evidenceUrl = "https://acme.example/robots.txt";
    if (mode === "basis") doc.permission.basis = "robots" as "license";
    if (mode === "wall") value.announcements[0].announcement = capture(doc.url, doc.body + '<p>Subscribe to read the full story</p>');
    if (mode === "sensitive-url") doc.url += "?token=synthetic-not-a-real-secret";
    if (mode === "missing-grant-evidence") delete doc.permission.evidenceCapture;
    if (mode === "tampered-grant-evidence") doc.permission.evidenceCapture!.body += "altered";
    assert.equal((await dry(value)).records.length, 0, mode);
  }
});

test("announcement: known production-compatible company identity is reused", async t => {
  const store = await openLocalStore(); t.after(() => store.close());
  await store.db.prepare(`INSERT INTO companies VALUES ('existing-acme','existing-slug','Acme','acme.example','',NULL,'United States','','','Other','','','unknown',0,0,'',NULL,'','https://acme.example',0,?)`).bind(now).run();
  const result = await runEngine({ ...base, sources: announcementSources(input()), db: store.db });
  assert.equal(result.records[0].company.id, "existing-acme");
  assert.equal(result.records[0].company.slug, "existing-slug");
  assert.equal(result.records[0].isNewCompany, false);
  assert.equal(result.counts.verifiedFundingEventsExistingCompanies, 1);
  assert.equal((await listDailyCompanies(store.db)).length, 1);
  assert.equal((await listDailyCompanies(store.db))[0].stage, "Seed", "known-company stage updates through the real companies table");
  await store.db.prepare("UPDATE companies SET latest_funding_date='2026-10-19',latest_funding_label='Newer Series B',stage='Series B' WHERE id='existing-acme'").run();
  const older = input("2026-10-17", "Acme Raises Pre-seed Funding");
  older.announcements[0].announcement.url = "https://acme.example/news/older-round";
  const olderResult = await runEngine({ ...base, inputId: "older-known-event", sources: announcementSources(older), db: store.db });
  assert.equal(olderResult.persistence.companiesAdded, 0);
  assert.equal(olderResult.persistence.eventsAdded, 1);
  const publicCompany = (await listDailyCompanies(store.db))[0];
  assert.equal(publicCompany.stage, "Series B");
  assert.equal(publicCompany.latestFundingLabel, "Newer Series B");
  assert.equal(publicCompany.latestFundingDate, "2026-10-19", "newly seen older event never rolls current company facts backward");
});

test("announcement: same round on different source URLs dedupes; source date preserved", async t => {
  const store = await openLocalStore(); t.after(() => store.close());
  const value = input();
  await runEngine({ ...base, sources: announcementSources(value), db: store.db });
  value.announcements[0].id = "reprint";
  value.announcements[0].announcement.url = "https://acme.example/news/reprint";
  const result = await runEngine({ ...base, inputId: "reprint", sources: announcementSources(value), db: store.db });
  assert.equal(result.persistence.companiesAdded, 0); assert.equal(result.persistence.eventsAdded, 0);
  assert.equal(result.records[0].fundingEvents.length, 1);
});

test("announcement: factual-only legal basis retains facts, not article expression; disease targeting is not fundraising speculation", async () => {
  const value = input();
  const item = value.announcements[0];
  item.announcement = capture(item.announcement.url, '<title>Acme Launches with $100 Million to Target Kidney Disease</title><time dateTime="2026-10-18">18 October 2026</time><p>Acme announced its launch with $100 million in financing. The $90 million Series A was led by investors.</p><p>A distinctive expressive paragraph about targeting the root cause of disease.</p>');
  item.headquarters = [capture("https://acme.example/about", '<h3>Headquarters: San Francisco Bay Area</h3><p>Coming soon</p><p>Other expressive content.</p>')];
  for (const doc of [item.announcement, ...item.headquarters]) doc.permission = factualPermission();
  const result = await dry(value);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].company.latestFundingLabel, "$90 million Series A");
  assert.equal(result.records[0].company.headquarters, "San Francisco Bay Area");
  assert.equal(result.assessments[0].candidate.document!.retention, "facts_only");
  assert.doesNotMatch(JSON.stringify(result), /distinctive expressive paragraph|Other expressive content/);
  assert.equal(result.records[0].company.indexedAt, undefined, "dry run must not invent a persistence date");
  const speculative = input();
  speculative.announcements[0].announcement = capture(speculative.announcements[0].announcement.url, speculative.announcements[0].announcement.body + '<p>Acme is targeting $20M financing.</p>');
  assert.equal((await dry(speculative)).records.length, 0);
});

test("announcement: factual-only rejection paths persist no article expression in source snapshots or reports", async t => {
  const store = await openLocalStore(); t.after(() => store.close());
  const marker = "DISTINCTIVE-ARTICLE-EXPRESSION-MUST-NOT-PERSIST";
  for (const [index, mode] of ["hq", "speculative", "subject", "http", "blocked"].entries()) {
    const value = input();
    const item = value.announcements[0];
    const original = item.announcement;
    item.announcement = capture(original.url, original.body + `<p>${marker}</p>`);
    if (mode === "hq") item.headquarters = [capture("https://acme.example/about", "US customers, HQ not established.")];
    if (mode === "speculative") item.announcement = capture(original.url, item.announcement.body + "<p>Acme is targeting $20M financing.</p>");
    if (mode === "subject") item.companyName = "Another";
    if (mode === "http") item.announcement.status = 403;
    for (const doc of [item.announcement, ...item.headquarters]) doc.permission = factualPermission();
    if (mode === "blocked") item.announcement.permission.status = "blocked";
    const result = await runEngine({ ...base, inputId: "rejected-facts-" + index, sources: announcementSources(value), db: store.db });
    assert.equal(result.records.length, 0, mode);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(marker), mode);
    const snapshots = await store.db.prepare("SELECT payload FROM daily_sources").all();
    assert.doesNotMatch(JSON.stringify(snapshots.results), new RegExp(marker), mode);
  }
  assert.equal((await listDailyCompanies(store.db)).length, 0);
});

test("announcement: reversed metadata attributes and invalid calendar dates handled", async () => {
  const value = input();
  value.announcements[0].announcement = capture(value.announcements[0].announcement.url, '<title>Acme Raises Seed Funding</title><meta content="2026-10-18" property="article:published_time"><p>Acme raised seed funding.</p>');
  assert.equal((await dry(value)).records.length, 1);
  assert.equal((await dry(input("2026-02-30"))).records.length, 0);
});

test("announcement: schedule inert and CLI refuses network/activation flags before I/O", async () => {
  assert.equal(ANNOUNCEMENT_SCHEDULE.enabled, false); assert.equal(ANNOUNCEMENT_SCHEDULE.network, false);
  assert.equal(ANNOUNCEMENT_SCHEDULE.maxPublicFetches, 0);
  for (const arg of ["--live", "--activate", "--remote", "--treg-key-file"]) await assert.rejects(announcementCli([arg]), /Unknown/);
  await assert.rejects(announcementCli(["--input", "absent", "--out", "absent", "--persist-local"]), /isolated --store/);
  await assert.rejects(announcementCli(["--dry-run", "--persist-local"]), /conflicts/);
});
