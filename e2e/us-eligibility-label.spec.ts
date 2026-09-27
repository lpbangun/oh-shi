import { expect, test } from "@playwright/test";

const label = "US-eligible incl. global/unspecified remote";
const semantics = ["US locations", "onsite", "bare/global/unspecified remote", "explicitly foreign-only", "not remote-only", "not verified US work authorization", "remote_status"];

test("eligibility label and honest semantics appear on all three public surfaces", async ({ request }) => {
  const coverage = await (await request.get("/api/v1/coverage")).json();
  const capabilities = await (await request.get("/api/v1/intelligence")).json();
  const llms = await (await request.get("/llms.txt")).text();
  for (const text of [JSON.stringify(coverage), JSON.stringify(capabilities), llms]) {
    expect(text).toContain(label);
    for (const phrase of semantics) expect(text.toLowerCase()).toContain(phrase.toLowerCase());
  }
});

test("remote_status remains an independent working consumer filter", async ({ request }) => {
  const result = await (await request.get("/api/v1/intelligence?view=jobs&remote_status=Remote")).json();
  expect(result.data.length).toBeGreaterThan(0);
  expect(result.data.every((row: { remoteStatus: string }) => row.remoteStatus === "Remote")).toBe(true);
});
