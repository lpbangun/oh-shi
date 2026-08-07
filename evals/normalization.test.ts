import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRole,
  isUsEligible,
  summarizeCanonicalJob,
} from "../lib/job-normalization";
import { normalizeSector, SECTOR_TAXONOMY } from "../lib/types";

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

test("industry normalization distinguishes common startup categories", () => {
  const cases: Array<[string, string]> = [
    ["AI / ML", "Artificial Intelligence"],
    ["SaaS / Enterprise", "Enterprise Software"],
    ["FinTech / Payments", "Financial Technology"],
    ["Biotech / Genomics", "Biotechnology & Life Sciences"],
    ["Healthcare / Clinical AI", "Healthcare"],
    ["Climate tech / Carbon", "Climate & Energy"],
    ["PropTech / Property management", "Real Estate"],
    ["Media / Entertainment", "Media & Entertainment"],
    ["Hardware / Robotics", "Hardware & Robotics"],
  ];

  for (const [industry, expected] of cases) {
    assert.equal(normalizeSector(industry), expected, industry);
    assert.ok(SECTOR_TAXONOMY.includes(expected as (typeof SECTOR_TAXONOMY)[number]));
  }
});

test("specific compound labels win over generic AI or software signals", () => {
  assert.equal(normalizeSector("AI / Developer tools"), "Developer Tools");
  assert.equal(normalizeSector("AI / Financial technology"), "Financial Technology");
  assert.equal(normalizeSector("AI / Biotech"), "Biotechnology & Life Sciences");
  assert.equal(normalizeSector("AI / Robotics"), "Hardware & Robotics");
  assert.equal(normalizeSector("AI / Scientific research"), "Science & Research");
  assert.equal(normalizeSector("AI / Precision medicine"), "Healthcare");
});

test("context reclassification is limited to missing or placeholder industries", () => {
  assert.equal(
    normalizeSector("Not published", { name: "Northstar Robotics" }),
    "Hardware & Robotics"
  );
  assert.equal(
    normalizeSector("Other", { name: "Acme AI", description: "Builds machine learning systems." }),
    "Artificial Intelligence"
  );
  assert.equal(
    normalizeSector("Unknown emerging category", { name: "Acme AI" }),
    "Other"
  );
  assert.equal(
    normalizeSector("Not published", { name: "Unknown Startup", description: "A technology company." }),
    "Other"
  );
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
