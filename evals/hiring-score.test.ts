import assert from "node:assert/strict";
import test from "node:test";
import {
  boardFreshnessPoints,
  computeEvidenceConfidence,
  computeHiringScore,
  evidenceConfidenceReceipt,
  fundingStagePoints,
  hiringScoreReceipt,
  openRoleGrowthPoints,
  openRoleVolumePoints,
} from "../lib/hiring-score";

const NOW = "2026-07-24T00:00:00.000Z";

function hiringInput(overrides: Partial<Parameters<typeof computeHiringScore>[0]> = {}) {
  return {
    openJobCount: 3,
    openedLast90: 2,
    closedLast90: 1,
    stage: "Series A",
    latestFundingDate: "2026-05-01",
    lastVerifiedAt: NOW,
    now: NOW,
    ...overrides,
  };
}

function evidenceInput(overrides: Partial<Parameters<typeof computeEvidenceConfidence>[0]> = {}) {
  return {
    openJobCount: 3,
    freshlyVerifiedOpenCount: 3,
    boardVerified: true,
    foundedYear: 2023,
    latestFundingDate: "2026-05-01",
    sourceUrl: "https://example.ai/about",
    careersUrl: "https://jobs.ashbyhq.com/example",
    lastVerifiedAt: NOW,
    now: NOW,
    ...overrides,
  };
}

test("scores stay within the published 0-100 bound in extremes", () => {
  const best = computeHiringScore(
    hiringInput({ openJobCount: 500, openedLast90: 400, closedLast90: 0, stage: "Growth" })
  );
  const worst = computeHiringScore(
    hiringInput({
      openJobCount: 0,
      openedLast90: 0,
      closedLast90: 30,
      stage: "Unknown",
      latestFundingDate: "2019-01-01",
      lastVerifiedAt: "2020-01-01T00:00:00.000Z",
    })
  );
  assert.ok(best <= 100 && best >= 0, `best in range, got ${best}`);
  assert.ok(worst <= 100 && worst >= 0, `worst in range, got ${worst}`);
  assert.ok(best > worst);
});

test("scoring is deterministic for identical inputs", () => {
  assert.equal(computeHiringScore(hiringInput()), computeHiringScore(hiringInput()));
  assert.equal(
    computeEvidenceConfidence(evidenceInput()),
    computeEvidenceConfidence(evidenceInput())
  );
});

test("open-role volume rises with roles and saturates", () => {
  assert.equal(openRoleVolumePoints(0), 0);
  assert.ok(openRoleVolumePoints(1) < openRoleVolumePoints(4));
  assert.ok(openRoleVolumePoints(4) < openRoleVolumePoints(12));
  assert.equal(Math.round(openRoleVolumePoints(12)), 30);
  assert.equal(Math.round(openRoleVolumePoints(400)), 30);
});

test("net role growth drives the growth component in both directions", () => {
  assert.equal(openRoleGrowthPoints(3, 3), 15);
  assert.equal(openRoleGrowthPoints(6, 0), 30);
  assert.equal(openRoleGrowthPoints(0, 6), 0);
  assert.ok(openRoleGrowthPoints(4, 1) > openRoleGrowthPoints(2, 1));
});

test("a board with no observed activity scores below a churn-neutral board", () => {
  assert.ok(openRoleGrowthPoints(0, 0) < openRoleGrowthPoints(3, 3));
});

test("funding recency decays and unknown funding sits between fresh and stale", () => {
  const fresh = fundingStagePoints("Series A", "2026-06-01", NOW);
  const aging = fundingStagePoints("Series A", "2025-06-01", NOW);
  const stale = fundingStagePoints("Series A", "2020-01-01", NOW);
  const unknown = fundingStagePoints("Series A", null, NOW);
  assert.ok(fresh > aging && aging > stale);
  assert.ok(unknown < fresh && unknown > stale);
});

test("later stages outrank earlier stages at equal funding recency", () => {
  assert.ok(
    fundingStagePoints("Growth", "2026-06-01", NOW) >
      fundingStagePoints("Seed", "2026-06-01", NOW)
  );
});

test("published funding-stage calibrations cover pre-seed through growth", () => {
  const now = "2026-08-02T00:00:00.000Z";
  const date = "2026-08-01";
  assert.equal(fundingStagePoints("Pre-seed", date, now), 12.5);
  assert.equal(fundingStagePoints("Seed", date, now), 15);
  assert.equal(fundingStagePoints("Series A", date, now), 20);
  assert.equal(fundingStagePoints("Series B", date, now), 22.5);
  assert.equal(fundingStagePoints("Series C", date, now), 23.75);
  assert.equal(fundingStagePoints("Series D", date, now), 25);
  assert.equal(fundingStagePoints("Series E", date, now), 25);
  assert.equal(fundingStagePoints("Growth", date, now), 25);
});

test("board freshness decays to zero for abandoned boards", () => {
  assert.equal(boardFreshnessPoints(NOW, NOW), 15);
  assert.equal(boardFreshnessPoints("2026-05-01T00:00:00.000Z", NOW), 0);
  assert.ok(boardFreshnessPoints("2026-07-14T00:00:00.000Z", NOW) < 15);
});

test("evidence confidence collapses when the canonical board was not verified", () => {
  const verified = computeEvidenceConfidence(evidenceInput());
  const unverified = computeEvidenceConfidence(evidenceInput({ boardVerified: false }));
  assert.ok(verified > unverified);
  assert.ok(unverified <= 70);
});

test("evidence confidence rewards fully re-verified open roles", () => {
  assert.ok(
    computeEvidenceConfidence(evidenceInput({ freshlyVerifiedOpenCount: 3 })) >
      computeEvidenceConfidence(evidenceInput({ freshlyVerifiedOpenCount: 1 }))
  );
});

test("evidence confidence penalises incomplete records", () => {
  assert.ok(
    computeEvidenceConfidence(evidenceInput()) >
      computeEvidenceConfidence(evidenceInput({ foundedYear: null, latestFundingDate: null }))
  );
});

test("a company with zero open roles keeps coverage credit when its board verified", () => {
  const empty = computeEvidenceConfidence(
    evidenceInput({ openJobCount: 0, freshlyVerifiedOpenCount: 0 })
  );
  assert.equal(empty, computeEvidenceConfidence(evidenceInput()));
});

test("hiring score and evidence confidence move independently", () => {
  const staleButComplete = evidenceInput({ lastVerifiedAt: "2026-06-01T00:00:00.000Z" });
  assert.ok(computeEvidenceConfidence(staleButComplete) > 0);
  assert.ok(
    computeHiringScore(hiringInput({ lastVerifiedAt: "2026-06-01T00:00:00.000Z" })) <
      computeHiringScore(hiringInput())
  );
});

test("published score receipts are complete, versioned, and sum to their totals", () => {
  for (const receipt of [
    hiringScoreReceipt(hiringInput()),
    evidenceConfidenceReceipt(evidenceInput()),
  ]) {
    assert.match(receipt.methodologyVersion, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(receipt.components.length, 4);
    assert.equal(
      Math.round(receipt.components.reduce((sum, component) => sum + component.points, 0) * 100) /
        100,
      receipt.value
    );
    assert.equal(
      receipt.components.reduce((sum, component) => sum + component.max, 0),
      100
    );
    for (const component of receipt.components) {
      assert.ok(component.name.length > 5);
      assert.ok(component.points >= 0);
      assert.ok(component.points <= component.max);
      assert.ok(Object.keys(component.input).length > 0);
    }
  }
});

test("receipt rounding never pushes a saturated component over its maximum", () => {
  const result = hiringScoreReceipt(
    hiringInput({
      openJobCount: 2,
      openedLast90: 0,
      closedLast90: 0,
      stage: "Seed",
      latestFundingDate: "2025-12-18",
      lastVerifiedAt: "2026-07-23T07:30:00.000Z",
      now: "2026-07-23T07:30:00.000Z",
    })
  );
  assert.equal(
    result.components.reduce((sum, component) => sum + component.points, 0),
    result.value
  );
  for (const component of result.components) {
    assert.ok(component.points <= component.max);
  }
});
