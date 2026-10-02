import assert from "node:assert/strict";
import test from "node:test";
import { stageCohortRows } from "../lib/cohort-staging";
import { buildStartupDomainPilot } from "../lib/domain-registry";

const base = {
  name: "Example Learning",
  website_url: "https://example-learning.com/",
  domain: "example-learning.com",
  sector: "Education technology",
  ats_hint: "personio",
  careers_url: "https://example-learning.jobs.personio.de/",
  access_mode: "public_page",
  terms_url: "https://example-learning.com/terms",
  evidence_url: "https://example-learning.jobs.personio.de/",
};
const now = "2026-09-30T00:00:00.000Z";

test("public page and robots reachability do not supply permission", () => {
  const output = stageCohortRows([base], now);
  assert.equal(output.issues.length, 0);
  assert.equal(output.staged[0].permission_status, "awaiting_permission");
  assert.equal(output.staged[0].runnable, false);
  assert.equal(output.staged[0].registry_evidence.permissionProvenance, undefined);
});

test("explicit reviewed access and reuse survives the registry evidence contract", () => {
  const permissionReview = {
    status: "permitted", scope: "automated_access_and_reuse",
    evidence_url: "https://example-learning.com/permission",
    reviewed_at: now, reviewer: "local-reviewer",
  } as const;
  const output = stageCohortRows([{ ...base, permission_review: permissionReview }], now);
  assert.equal(output.issues.length, 0);
  assert.equal(output.staged[0].runnable, true);
  const record = output.staged[0].registry_evidence;
  assert.deepEqual(record.permissionProvenance, {
    evidenceUrl: permissionReview.evidence_url,
    scope: permissionReview.scope,
    reviewedAt: now,
    reviewer: permissionReview.reviewer,
  });
  const pilot = buildStartupDomainPilot([record], 1);
  assert.equal(pilot.entries[0].evidence[0].permissionProvenance?.evidenceUrl,
    permissionReview.evidence_url);
});

test("manual, awaiting, and contradictory modes stay excluded", () => {
  const review = { status: "permitted", scope: "automated_access_and_reuse",
    evidence_url: "https://example-learning.com/permission", reviewed_at: now,
    reviewer: "local-reviewer" };
  const manual = stageCohortRows([{ ...base, access_mode: "manual_import" }], now);
  assert.equal(manual.staged[0].permission_status, "manual_only");
  const awaiting = stageCohortRows([{ ...base, access_mode: "awaiting_permission" }], now);
  assert.equal(awaiting.staged[0].permission_status, "awaiting_permission");
  const contradictory = stageCohortRows([{ ...base, access_mode: "manual_import",
    permission_review: review }], now);
  assert.equal(contradictory.staged[0].runnable, false);
  assert.deepEqual(contradictory.issues, [{ index: 0,
    reason: "contradictory_or_incomplete_permission_review" }]);
});

test("staging rejects duplicate and malformed employer identity", () => {
  const output = stageCohortRows([base, base, { ...base, domain: "other.com" }], now);
  assert.equal(output.staged.length, 1);
  assert.deepEqual(output.issues.map((issue) => issue.reason),
    ["duplicate_domain", "invalid_cohort_row"]);
});
