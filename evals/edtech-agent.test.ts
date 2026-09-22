import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  REVIEWED_PACK_ROWS,
  reviewedPackCareersUrl,
  reviewedPackIdentity,
} from "../lib/reviewed-pack-registry";

const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), "utf8");

test("reviewed packs expose unique canonical source identities", () => {
  assert.equal(REVIEWED_PACK_ROWS.length, 95);
  const identities = REVIEWED_PACK_ROWS.map(reviewedPackIdentity);
  assert.equal(new Set(identities.map((item) => item.sourceId)).size, identities.length);
  assert.ok(identities.every((item) => item.domain && item.companyId && item.slug));
});

test("reviewed pack careers URLs remain employer-facing application surfaces", () => {
  for (const row of REVIEWED_PACK_ROWS) {
    const url = new URL(reviewedPackCareersUrl(row));
    assert.equal(url.protocol, "https:");
    assert.ok(!/boards-api\.greenhouse\.io|api\.lever\.co|api\.ashbyhq\.com/.test(url.hostname));
  }
});

test("reviewed pack sources are registered durably with a daily cadence", async () => {
  const data = await read("lib/data.ts");
  const refresh = await read("lib/refresh.ts");
  const schema = await read("db/schema.ts");
  assert.match(data, /registerReviewedPackSources\(discoveredAt\)/);
  assert.match(data, /refresh_cadence[\s\S]*'daily'/);
  assert.match(schema, /refreshCadence: text\("refresh_cadence"\)/);
  assert.match(refresh, /refresh_cadence=\?/);
  assert.match(refresh, /\.bind\(cadence\)/);
});

test("daily reviewed-pack workflow refreshes canonical D1 storage", async () => {
  const workflow = await read(".github/workflows/daily-edtech-pack.yml");
  const script = await read("scripts/run-reviewed-pack-refresh.mjs");
  assert.match(workflow, /cron:\s*["']15 8 \* \* \*["']/);
  assert.match(workflow, /OH_SHI_INGEST_TOKEN/);
  assert.match(workflow, /run-reviewed-pack-refresh\.mjs/);
  assert.doesNotMatch(workflow, /upload-artifact|outputs\/edtech-ingest/);
  assert.match(script, /phase=canonical&cadence=daily/);
  assert.match(script, /runVersionedRefresh/);
});

test("public discovery keeps one canonical jobs API", async () => {
  const llms = await read("app/llms.txt/route.ts");
  const policy = await read("public/agent-policy.json");
  assert.doesNotMatch(llms, /api\/v1\/agent\/jobs/);
  assert.doesNotMatch(policy, /edtech_jobs/);
  assert.match(llms, /api\/v1\/intelligence\?view=jobs/);
});
