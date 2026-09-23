import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  COHORT_MANIFEST_PATH,
  parseCohortManifest,
  type CohortManifestRow,
} from "../lib/cohort-manifest";
import { cohortEvidenceSourceId } from "../lib/cohort-manifest-import";
import { isTransientDiscoveryError } from "../lib/discovery-policy";

/**
 * Characterization pins for the user-approved discovery remediation
 * (2026-09-23, `AGENTS.md` "User-approved remediation"). The remediation
 * changes exactly two behaviors:
 *
 *   1. the Workers platform subrequest ceiling ("Too many subrequests by
 *      single Worker invocation") becomes deferrable instead of terminal, and
 *   2. personio/recruitee board ids are derived from the careers URL hostname
 *      instead of its path.
 *
 * Everything else about the error map and the source-id derivation must stay
 * byte-unchanged. These characterization tests were written first and started
 * green against the pre-remediation code; the remediation's own tests live in
 * the same file and started red against that same code.
 */

const root = process.cwd();

type ErrorCase = { name: string; error: unknown; transient: boolean };

test("discovery error map classifies exactly the documented transient set", () => {
  // The map the per-candidate catch sites consult (`lib/discovery.ts` binds the
  // queue status to this verdict: transient -> `discovered` + `next_attempt_at`,
  // otherwise the terminal `needs_review` stamp). Pinned case by case so the
  // subrequest-ceiling reclassification cannot silently move any other error.
  const cases: ErrorCase[] = [
    { name: "TypeError", error: new TypeError("fetch failed"), transient: true },
    { name: "AbortError", error: { name: "AbortError", message: "aborted" }, transient: true },
    { name: "TimeoutError", error: { name: "TimeoutError" }, transient: true },
    { name: "status 408", error: { status: 408 }, transient: true },
    { name: "status 425", error: { status: 425 }, transient: true },
    { name: "status 429", error: { status: 429 }, transient: true },
    { name: "status 500", error: { status: 500 }, transient: true },
    { name: "status 503", error: { status: 503 }, transient: true },
    { name: "timeout message", error: new Error("request timeout"), transient: true },
    { name: "network message", error: new Error("network failure"), transient: true },
    {
      name: "robots message (transient here; the call site refuses it as blocked first)",
      error: new Error("robots_policy_disallows_all_website_probes"),
      transient: true,
    },
    { name: "status 400", error: { status: 400 }, transient: false },
    { name: "status 403", error: { status: 403 }, transient: false },
    { name: "status 404 (no board)", error: { status: 404 }, transient: false },
    { name: "canonical board not detected", error: new Error("canonical_ats_not_detected"), transient: false },
    { name: "ambiguous boards", error: new Error("multiple_canonical_ats_candidates"), transient: false },
    { name: "unsupported career system", error: new Error("unsupported_external_career_system"), transient: false },
    { name: "no US-eligible openings", error: new Error("no_verified_us_open_jobs"), transient: false },
    { name: "null", error: null, transient: false },
    { name: "undefined", error: undefined, transient: false },
    { name: "string", error: "boom", transient: false },
    { name: "number", error: 42, transient: false },
  ];
  for (const item of cases) {
    assert.equal(
      isTransientDiscoveryError(item.error),
      item.transient,
      `${item.name} must classify as ${item.transient ? "transient" : "terminal"}`
    );
  }
});

test("cohort evidence source ids keep their path-derived form for the path-keyed families", async () => {
  const text = await readFile(path.join(root, COHORT_MANIFEST_PATH), "utf8");
  const { rows, issues } = parseCohortManifest(text);
  assert.deepEqual(issues, []);
  const byDomain = new Map(rows.map((row) => [row.domain, row]));

  // Real shipped manifest rows, one per family whose board slug lives in the
  // URL path. The remediation must not touch these.
  const pins: Array<[string, string]> = [
    ["deepgram.com", "curated:deepgram"],
    ["fivetran.com", "curated:fivetran"],
    ["handoff.ai", "curated:handoff"],
    ["hokali.com", "curated:hokali"],
    ["continental.com", "curated:continental"],
    // The structured family's careers URL is the employer's own site, so the
    // path (or its absence) is not a board id either way — unchanged here, and
    // deliberately left alone by the remediation.
    ["insforge.dev", "curated:insforge.dev"],
    ["mozilla.org", "curated:listings"],
  ];
  for (const [domain, expected] of pins) {
    const row = byDomain.get(domain);
    assert.ok(row, `${domain} must exist in the manifest`);
    assert.equal(cohortEvidenceSourceId(row), expected, `${domain} derivation is unchanged`);
  }

  // Enumerated (staged) rows cite the Wikidata entity that named the employer.
  const staged = rows.filter((row) => row.access_mode !== "public_page");
  assert.ok(staged.length > 0);
  for (const row of staged) {
    assert.match(cohortEvidenceSourceId(row), /^wikidata:Q\d+$/);
  }

  // Fallbacks: no board path -> the registrable domain; unparsable URL -> the
  // row's domain. Both are pre-existing behavior.
  const base: CohortManifestRow = {
    name: "Example Health",
    website_url: "https://examplehealth.example",
    domain: "examplehealth.example",
    sector: "Healthcare",
    ats_hint: "structured",
    careers_url: null,
    access_mode: "public_page",
    terms_url: "https://examplehealth.example/terms",
    evidence_url: "https://examplehealth.example",
    notes: "general:v1 POC seed; probe receipt evidence/cohorts/probes/example.json",
  };
  assert.equal(cohortEvidenceSourceId(base), "curated:examplehealth.example");
  assert.equal(
    cohortEvidenceSourceId({ ...base, careers_url: "not a url", evidence_url: "not a url" }),
    "curated:examplehealth.example"
  );
  assert.equal(
    cohortEvidenceSourceId({ ...base, careers_url: "https://examplehealth.example/careers" }),
    "curated:careers"
  );
});
