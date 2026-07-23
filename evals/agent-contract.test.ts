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
    "/exports/companies.jsonl",
    "/exports/jobs.jsonl",
    "/exports/daily-changes.json",
  ]) {
    assert.ok(llms.includes(endpoint), `llms.txt must advertise ${endpoint}`);
  }
  const policy = JSON.parse(policyText);
  assert.equal(policy.access, "public");
  assert.equal(policy.authentication, "none for read endpoints");
  assert.equal(policy.preferred_entrypoint, "/api/v1/jobs");
  assert.equal(policy.instructions, "/llms.txt");
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
