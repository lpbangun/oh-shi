import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), "utf8");

const publicRoutes = [
  "app/api/v1/companies/route.ts",
  "app/api/v1/jobs/route.ts",
  "app/api/v1/changes/route.ts",
  "app/api/v1/intelligence/route.ts",
  "app/exports/companies.jsonl/route.ts",
  "app/exports/jobs.jsonl/route.ts",
  "app/exports/daily-changes.json/route.ts",
  "app/llms.txt/route.ts",
];

test("public agent routes are GET-only and do not require auth", async () => {
  for (const route of publicRoutes) {
    const source = await read(route);
    assert.match(source, /export async function GET|export function GET/);
    assert.doesNotMatch(source, /authorization|INGEST_TOKEN/i);
  }
});

test("agent discovery files advertise every stable public surface", async () => {
  const [llms, policyText] = await Promise.all([
    read("app/llms.txt/route.ts"),
    read("public/agent-policy.json"),
  ]);
  for (const endpoint of [
    "/api/v1/companies",
    "/api/v1/jobs",
    "/api/v1/changes",
    "/api/v1/intelligence",
    "/exports/companies.jsonl",
    "/exports/jobs.jsonl",
    "/exports/daily-changes.json",
  ]) {
    assert.ok(llms.includes(endpoint), `llms.txt must advertise ${endpoint}`);
  }
  const policy = JSON.parse(policyText);
  assert.equal(policy.access, "public");
  assert.equal(policy.authentication, "none for read endpoints");
  assert.equal(policy.preferred_entrypoint, "/api/v1/intelligence");
  assert.equal(policy.instructions, "/llms.txt");
  assert.equal(policy.capabilities.jobs, "/api/v1/intelligence?view=jobs");
  assert.equal(policy.capabilities.companies, "/api/v1/intelligence?view=companies");
  assert.equal(policy.capabilities.movements, "/api/v1/intelligence?view=movements");
  assert.equal(policy.capabilities.sectors, "/api/v1/intelligence?view=sectors");
});

test("agent instructions use the actual public field casing and query recipes", async () => {
  const llms = await read("app/llms.txt/route.ts");
  assert.ok(llms.includes("canonicalUrl"));
  assert.doesNotMatch(llms, /canonical_url/);
  for (const view of ["jobs", "companies", "movements", "sectors"]) {
    assert.ok(llms.includes(`view=${view}`), `llms.txt must document the ${view} view`);
  }
  assert.match(llms, /next_cursor/);
  assert.match(llms, /HTTP 400/);
  assert.match(llms, /sector=Healthcare&min_confidence=80/);
  assert.doesNotMatch(llms, /sector=Health&/);
});

test("API envelopes remain versioned, incremental, and licensed", async () => {
  const dataSource = await read("lib/data.ts");
  for (const field of [
    "schema_version",
    "generated_at",
    "cursor",
    "license",
    "data",
  ]) {
    assert.ok(dataSource.includes(field), `API envelope must contain ${field}`);
  }
  assert.match(dataSource, /schema_version:\s*"1\.0"/);
  assert.match(dataSource, /new Date\(\)\.toISOString\(\)/);
});

test("canonical refresh is protected", async () => {
  const source = await read("app/api/internal/refresh/route.ts");
  assert.match(source, /export async function POST/);
  assert.match(source, /authorization/i);
  assert.match(source, /INGEST_TOKEN/);
  assert.match(source, /status:\s*401/);
});
