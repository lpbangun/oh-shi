import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { companyScoreReceipts } from "../lib/hiring-score";
import { seedChanges, seedCompanies, seedJobs } from "../lib/seed";

test("refresh and public receipts use job change events for 90-day growth", async () => {
  const source = await readFile(path.join(process.cwd(), "lib/refresh.ts"), "utf8");
  assert.match(source, /FROM changes\s+JOIN jobs ON jobs\.id = changes\.entity_id/);
  assert.match(source, /changes\.change_type='job_opened'/);
  assert.match(source, /changes\.change_type='job_closed'/);
  assert.match(source, /changes\.occurred_at >= \?/);
  assert.match(source, /\.bind\(company\.id, windowStart, now\)/);
  assert.doesNotMatch(source, /first_seen_at >= \?/);

  const cognition = seedCompanies.find(
    (company) => company.id === "company_cognition"
  );
  assert.ok(cognition);
  const receipts = companyScoreReceipts(
    cognition,
    seedJobs,
    seedChanges,
    cognition.lastVerifiedAt
  );
  const growth = receipts.hiring.components.find(
    (component) => component.name === "90-day net role growth"
  );
  assert.deepEqual(growth?.input, {
    openedLast90: 1,
    closedLast90: 0,
    windowDays: 90,
  });
});
