import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { registryProbeSlugs, registryVendorBoardSlugs } from "../lib/discovery-evidence-slugs";
import { DISCOVERY_PIPELINE_VERSION } from "../lib/discovery-version";

const permittedPoc = {
  sourceKind: "curated_cohort",
  sourceClassification: "general_v1_poc",
  permissionStatus: "permitted",
};

test("only permitted Personio/Recruitee board-host evidence supplies a corroborating slug", () => {
  assert.deepEqual(registryVendorBoardSlugs([
    { ...permittedPoc, sourceId: "curated:demodesk-gmbh", evidenceUrl: "https://demodesk-gmbh.jobs.personio.de/" },
    { ...permittedPoc, sourceId: "curated:bunq", evidenceUrl: "https://bunq.recruitee.com/" },
    { ...permittedPoc, sourceId: "curated:demodesk-gmbh", evidenceUrl: "https://demodesk-gmbh.jobs.personio.com/jobs" },
    // A path-derived curated id names a page, not the Personio board "listings".
    { ...permittedPoc, sourceId: "curated:listings", evidenceUrl: "https://www.mozilla.org/en-US/careers/listings/" },
    { ...permittedPoc, sourceId: "curated:demodesk-gmbh", evidenceUrl: "https://other.jobs.personio.de/" },
    { ...permittedPoc, sourceId: "wikidata:Q12345", evidenceUrl: "https://demodesk-gmbh.jobs.personio.de/" },
    { ...permittedPoc, sourceId: "curated:unrelated", evidenceUrl: "https://jobs.ashbyhq.com/unrelated/" },
    { ...permittedPoc, sourceId: "curated:www", evidenceUrl: "https://www.recruitee.com/" },
    { ...permittedPoc, sourceId: "curated:denied", permissionStatus: "manual_only", evidenceUrl: "https://denied.recruitee.com/" },
    { ...permittedPoc, sourceId: "curated:staged", sourceClassification: "general_v1_staged", evidenceUrl: "https://staged.recruitee.com/" },
    { ...permittedPoc, sourceId: "curated:other-kind", sourceKind: "directory", evidenceUrl: "https://other-kind.recruitee.com/" },
    { ...permittedPoc, sourceId: "curated:malformed", evidenceUrl: "not a URL" },
  ]), ["demodesk-gmbh", "bunq"]);
});

test("unrelated evidence may remain a Greenhouse probe candidate but never authorizes vendor bypass", () => {
  const slugs = registryProbeSlugs([
    { ...permittedPoc, sourceId: "curated:listings", evidenceUrl: "https://www.mozilla.org/en-US/careers/listings/" },
    { ...permittedPoc, sourceId: "curated:demodesk-gmbh", evidenceUrl: "https://demodesk-gmbh.jobs.personio.de/" },
  ]);
  assert.deepEqual(slugs.candidates, ["listings", "demodesk-gmbh"]);
  assert.deepEqual(slugs.corroborating, ["demodesk-gmbh"]);
});

test("the narrowed evidence authorization advances the discovery version for safe rechecks", () => {
  assert.match(DISCOVERY_PIPELINE_VERSION, /:slug-corroboration-2$/);
});

test("discovery separates probe candidates from vendor-host authorization", async () => {
  const source = await readFile("lib/discovery.ts", "utf8");
  assert.match(source, /registryProbeSlugs\(evidence\.results\)/);
  assert.match(source, /extraSlugs: registrySlugs\.candidates/);
  assert.match(source, /corroboratingSlugs: registrySlugs\.corroborating/);
  assert.match(source, /source_kind as sourceKind/);
  assert.match(source, /evidence_url as evidenceUrl/);
});
