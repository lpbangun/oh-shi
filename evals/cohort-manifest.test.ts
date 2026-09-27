import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  COHORT_ATS_FAMILIES,
  COHORT_CANDIDATES_PATH,
  COHORT_ENUMERATION_RECEIPT_PATH,
  COHORT_FLOORS,
  COHORT_MANIFEST_PATH,
  COHORT_POC_NOTE,
  COHORT_STAGED_NOTE,
  cohortCompositionFailures,
  parseCohortManifest,
  summarizeCohortManifest,
  validateCohortManifestRow,
} from "../lib/cohort-manifest";

const root = process.cwd();
const wikidataEntity = /^https:\/\/www\.wikidata\.org\/wiki\/Q\d+$/;

async function readManifest() {
  const text = await readFile(path.join(root, COHORT_MANIFEST_PATH), "utf8");
  const parsed = parseCohortManifest(text);
  return { text, ...parsed };
}

test("general:v1 manifest parses line by line with a clean schema", async () => {
  const { rows, issues, text } = await readManifest();
  assert.deepEqual(issues, [], "every manifest line must satisfy the architecture §3.2 row schema");
  assert.ok(rows.length > 0, "the manifest must not be empty");
  const lines = text.split("\n").filter((line) => line.trim());
  assert.equal(lines.length, rows.length, "every non-empty line must be a manifest row");
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

test("general:v1 composition meets the architecture floors", async () => {
  const { rows } = await readManifest();
  const summary = summarizeCohortManifest(rows);
  assert.ok(
    summary.pocRows >= COHORT_FLOORS.pocRows,
    `public_page rows ${summary.pocRows} must be at least ${COHORT_FLOORS.pocRows}`
  );
  assert.deepEqual(summary.missingFamilies, [], "every ATS family needs at least one POC employer");
  assert.ok(
    summary.total >= COHORT_FLOORS.totalRows,
    `total rows ${summary.total} must be at least ${COHORT_FLOORS.totalRows}`
  );
  assert.ok(
    summary.stagedPendingShare > COHORT_FLOORS.stagedPendingShare,
    `staged rows must be more than half honest pending (got ${summary.stagedPendingShare})`
  );
  assert.deepEqual(summary.duplicateDomains, [], "one manifest row per registrable domain");
  assert.deepEqual(cohortCompositionFailures(summary), []);
  assert.equal(
    summary.byAccessMode.public_page + summary.byAccessMode.awaiting_permission +
      summary.byAccessMode.manual_import,
    summary.total
  );
});

test("POC rows carry probe receipts and staged rows stay honestly pending", async () => {
  const { rows } = await readManifest();
  for (const row of rows) {
    assert.match(row.terms_url, /^https:\/\//, `${row.domain} terms_url must be https`);
    assert.match(row.evidence_url, /^https:\/\//, `${row.domain} evidence_url must be https`);
    if (row.access_mode === "public_page") {
      assert.ok(row.notes.startsWith(COHORT_POC_NOTE), `${row.domain} must be labelled a POC seed`);
      assert.match(row.notes, /evidence\/cohorts\/probes\/[a-z0-9._-]+\.json/, `${row.domain} must cite its probe receipt`);
      assert.ok(row.careers_url, `${row.domain} POC rows must carry the confirmed board URL`);
      assert.match(String(row.careers_url), /^https:\/\//);
      assert.notEqual(row.ats_hint, "unknown", `${row.domain} POC rows must name the confirmed ATS family`);
      assert.equal(row.evidence_url, row.careers_url, `${row.domain} POC evidence is the probed board URL`);
    } else {
      assert.ok(row.notes.startsWith(COHORT_STAGED_NOTE), `${row.domain} must be labelled staged`);
      assert.ok(
        row.notes.includes(COHORT_ENUMERATION_RECEIPT_PATH),
        `${row.domain} staged rows cite the enumeration receipt`
      );
      assert.equal(row.careers_url, null, `${row.domain} staged rows must not carry an invented careers URL`);
      assert.match(row.evidence_url, wikidataEntity, `${row.domain} staged evidence is the Wikidata entity`);
      assert.equal(row.ats_hint, "unknown");
      assert.notEqual(row.access_mode, "public_page");
    }
  }
});

test("POC employers cover each ATS family from the curated candidate set", async () => {
  const { rows } = await readManifest();
  const summary = summarizeCohortManifest(rows);
  const candidates = JSON.parse(
    await readFile(path.join(root, COHORT_CANDIDATES_PATH), "utf8")
  ) as { candidates: Array<{ id: string; domain: string; provenance: { kind: string; detail: string } }> };
  const candidateDomains = new Set(candidates.candidates.map((candidate) => candidate.domain));
  assert.ok(candidates.candidates.length >= 50, "the POC candidate set must be curated, not improvised");
  for (const entry of summary.families) {
    assert.ok(entry.pocRows >= 1, `family ${entry.family} must have a POC employer`);
    assert.ok(entry.employers.length >= 1);
  }
  assert.deepEqual(
    summary.families.map((entry) => entry.family),
    [...COHORT_ATS_FAMILIES]
  );
  for (const row of rows.filter((item) => item.access_mode === "public_page")) {
    assert.ok(
      candidateDomains.has(row.domain),
      `${row.domain} must come from the curated candidate set (no invented boards)`
    );
  }
  for (const candidate of candidates.candidates) {
    assert.ok(candidate.provenance?.kind && candidate.provenance?.detail, `${candidate.id} documents its provenance`);
  }
});

test("row validation refuses dishonest or incomplete cohort rows", () => {
  const base = {
    name: "Example Health",
    website_url: "https://examplehealth.example",
    domain: "examplehealth.example",
    sector: "Healthcare",
    ats_hint: "greenhouse",
    careers_url: "https://job-boards.greenhouse.io/examplehealth",
    access_mode: "public_page",
    terms_url: "https://www.greenhouse.com/legal",
    evidence_url: "https://job-boards.greenhouse.io/examplehealth",
    notes: `general:v1 POC seed; probe receipt evidence/cohorts/probes/greenhouse-examplehealth.json`,
  };
  assert.equal(validateCohortManifestRow(base).ok, true);
  assert.equal(validateCohortManifestRow({ ...base, terms_url: "http://examplehealth.example/terms" }).ok, false);
  assert.equal(validateCohortManifestRow({ ...base, evidence_url: "not-a-url" }).ok, false);
  assert.equal(validateCohortManifestRow({ ...base, access_mode: "permitted" }).ok, false);
  assert.equal(validateCohortManifestRow({ ...base, domain: "other.example" }).ok, false);
  assert.equal(validateCohortManifestRow({ ...base, name: "Q1234" }).ok, false);
  assert.equal(validateCohortManifestRow({ ...base, ats_hint: "workday" }).ok, false);
  assert.equal(validateCohortManifestRow({ ...base, notes: "general:v1 staged; enumeration receipt x" }).ok, false);
  const { careers_url: _unused, ...missing } = base;
  assert.equal(validateCohortManifestRow(missing).ok, false);
  const staged = validateCohortManifestRow({
    ...base,
    ats_hint: "unknown",
    careers_url: null,
    access_mode: "awaiting_permission",
    terms_url: "https://www.wikidata.org/wiki/Wikidata:Copyright",
    evidence_url: "https://www.wikidata.org/wiki/Q12345",
    notes: `general:v1 staged; enumeration receipt ${COHORT_ENUMERATION_RECEIPT_PATH}`,
  });
  assert.equal(staged.ok, true);
});
