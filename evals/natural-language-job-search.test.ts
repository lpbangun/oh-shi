import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeEmploymentType,
  parseNaturalLanguageJobSearch,
} from "../lib/natural-language-job-search";
import { buildJobSearchSql, parseJobSearch } from "../lib/job-search";

const params = (query: string) => new URLSearchParams(query);

test("natural-language search resolves role and work arrangement", () => {
  const parsed = parseNaturalLanguageJobSearch("open remote operations jobs");
  assert.equal(parsed.filters.status, "verified_open");
  assert.equal(parsed.filters.role_family, "Operations");
  assert.equal(parsed.filters.remote_status, "Remote");
  assert.equal(parsed.filters.q, null);
  assert.match(parsed.interpretation, /Operations/);
});

test("natural-language search resolves employment type and location", () => {
  const parsed = parseNaturalLanguageJobSearch("full-time engineering jobs in San Francisco");
  assert.equal(parsed.filters.employment_type, "Full time");
  assert.equal(parsed.filters.role_family, "Engineering");
  assert.equal(parsed.filters.location, "San Francisco");
  assert.equal(parsed.filters.q, null);
});

test("natural-language search resolves company, residual text, and relative dates", () => {
  const now = new Date("2026-09-17T12:34:56.000Z");
  const parsed = parseNaturalLanguageJobSearch(
    "senior remote engineer jobs at Cognition added this week",
    now
  );
  assert.equal(parsed.filters.company, "Cognition");
  assert.equal(parsed.filters.role_family, "Engineering");
  assert.equal(parsed.filters.remote_status, "Remote");
  assert.equal(parsed.filters.q, "senior");
  assert.equal(parsed.filters.new_since, "2026-09-14T00:00:00.000Z");
});

test("natural-language search accepts a bare relative date phrase", () => {
  const parsed = parseNaturalLanguageJobSearch(
    "remote engineering jobs this week",
    new Date("2026-09-17T12:34:56.000Z")
  );
  assert.equal(parsed.filters.role_family, "Engineering");
  assert.equal(parsed.filters.remote_status, "Remote");
  assert.equal(parsed.filters.new_since, "2026-09-14T00:00:00.000Z");
  assert.equal(parsed.filters.q, null);
});

test("employment aliases normalize to canonical values", () => {
  assert.equal(normalizeEmploymentType("full-time"), "Full time");
  assert.equal(normalizeEmploymentType("FullTime"), "Full time");
  assert.equal(normalizeEmploymentType("contractor"), "Contract");
  assert.equal(normalizeEmploymentType("intern"), "Internship");
  assert.equal(normalizeEmploymentType("volunteer"), null);
});

test("job search accepts structured employment type and natural-language q", () => {
  const structured = parseJobSearch(params("employment_type=full-time"));
  assert.equal(structured.employmentType, "Full time");

  const natural = parseJobSearch(params("q=remote%20engineering%20jobs"));
  assert.equal(natural.roleFamily, "Engineering");
  assert.equal(natural.remoteStatus, "Remote");
  assert.equal(natural.q, null);

  const sql = buildJobSearchSql(structured, "jobs.id");
  assert.match(sql.dataSql, /employment_type/);
  assert.deepEqual(sql.bindings, ["verified_open", "Full time"]);
});

test("job search applies inferred status without overriding explicit status controls", () => {
  assert.equal(parseJobSearch(params("q=closed%20engineering%20jobs")).status, "verified_closed");
  assert.equal(parseJobSearch(params("q=all%20engineering%20jobs")).status, "all");
  assert.equal(
    parseJobSearch(params("q=closed%20engineering%20jobs&status=verified_open")).status,
    "verified_open"
  );
  assert.equal(
    parseJobSearch(params("q=closed%20engineering%20jobs&include_closed=false")).status,
    "verified_open"
  );
});
