import assert from "node:assert/strict";
import test from "node:test";
import { buildJobSearchSql, parseJobSearch } from "../lib/job-search";
import { seedJobs } from "../lib/seed";

for (const [term, title] of [
  ["nurse", "Nurse Practitioner"],
  ["driver", "Delivery Driver"],
  ["accountant", "Staff Accountant"],
] as const) {
  test(`q=${term} stays residual title search, not role family Other`, () => {
    const query = parseJobSearch(new URLSearchParams({ q: term }), { defaultLimit: 100 });
    assert.equal(query.q, term);
    assert.equal(query.roleFamily, null);
    const plan = buildJobSearchSql(query, "jobs.id");
    assert.match(plan.dataSql, /LOWER\(jobs\.title\) LIKE \?/);
    assert.ok(plan.bindings.includes(`%${term}%`));
    assert.ok(seedJobs.some((job) => job.title === title && job.title.toLowerCase().includes(term)));
  });
}
