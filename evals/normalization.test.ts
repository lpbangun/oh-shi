import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRole,
  isUsEligible,
  summarizeCanonicalJob,
} from "../lib/job-normalization";

test("role classification covers the core startup hiring lanes", () => {
  assert.equal(classifyRole("People Operations Associate"), "People operations");
  assert.equal(classifyRole("Recruiting Coordinator"), "People operations");
  assert.equal(classifyRole("GTM Strategy Lead"), "GTM");
  assert.equal(classifyRole("Chief of Staff"), "Operations");
  assert.equal(classifyRole("Scientific Evals"), "Data and research");
  assert.equal(classifyRole("Full Stack Engineer"), "Engineering");
  assert.equal(classifyRole("Product Designer"), "Product");
  assert.equal(classifyRole("Office Barista"), "Other");
});

test("U.S. eligibility accepts explicit U.S. and remote signals", () => {
  assert.equal(
    isUsEligible({
      title: "Operator",
      address: { postalAddress: { addressCountry: "United States" } },
    }),
    true
  );
  assert.equal(isUsEligible({ title: "Operator", location: "New York City" }), true);
  assert.equal(isUsEligible({ title: "Operator", location: "Remote", isRemote: true }), true);
  assert.equal(isUsEligible({ title: "Operator", location: "London, UK" }), false);
});

test("canonical summaries are normalized and bounded", () => {
  const summary = summarizeCanonicalJob({
    title: "Operator",
    descriptionPlain: `  Build   systems.\n\n${"A".repeat(400)}  `,
  });
  assert.ok(summary.startsWith("Build systems."));
  assert.equal(summary.length, 220);
  assert.equal(
    summarizeCanonicalJob({ title: "Operator" }),
    "Canonical posting for Operator."
  );
});
