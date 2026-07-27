import assert from "node:assert/strict";
import test from "node:test";
import {
  IntelligenceQueryError,
  encodeCursor,
  pageData,
  parseCursor,
  parseIsoFilter,
  parseLimit,
  parseNumberFilter,
  parseView,
  validateParameters,
} from "../lib/intelligence-query";

const params = (query: string) => new URLSearchParams(query);

test("intelligence views and parameters are strict", () => {
  assert.equal(parseView(params("view=jobs")), "jobs");
  assert.equal(parseView(params("")), null);
  assert.throws(() => parseView(params("view=unknown")), IntelligenceQueryError);
  assert.doesNotThrow(() => validateParameters(params("view=jobs&location=Remote"), "jobs"));
  assert.throws(
    () => validateParameters(params("view=jobs&industry=AI"), "jobs"),
    /Unknown parameter/
  );
  assert.throws(
    () => validateParameters(params("location=Remote"), null),
    /Select a view/
  );
});

test("limits use view defaults and reject unsafe values", () => {
  assert.equal(parseLimit(params(""), "companies"), 10);
  assert.equal(parseLimit(params(""), "movements"), 25);
  assert.equal(parseLimit(params("limit=50"), "jobs"), 50);
  for (const value of ["0", "101", "-1", "3.5", "many"]) {
    assert.throws(() => parseLimit(params(`limit=${value}`), "jobs"));
  }
});

test("cursors are view-bound, deterministic, and gap-free", () => {
  assert.equal(encodeCursor("companies", 10), "v1.companies.10");
  assert.equal(parseCursor(params("cursor=v1.companies.10"), "companies"), 10);
  assert.throws(() => parseCursor(params("cursor=v1.jobs.10"), "companies"));
  assert.throws(() => parseCursor(params("cursor=garbage"), "companies"));

  const first = pageData([1, 2, 3, 4, 5], "companies", 0, 2);
  assert.deepEqual(first.data, [1, 2]);
  assert.equal(first.page.next_cursor, "v1.companies.2");
  const second = pageData([1, 2, 3, 4, 5], "companies", 2, 2);
  assert.deepEqual(second.data, [3, 4]);
  assert.equal(second.page.next_cursor, "v1.companies.4");
  const last = pageData([1, 2, 3, 4, 5], "companies", 4, 2);
  assert.deepEqual(last.data, [5]);
  assert.equal(last.page.next_cursor, null);
});

test("numeric and ISO filters fail closed", () => {
  assert.equal(parseNumberFilter(params("min_signal=72"), "min_signal"), 72);
  assert.throws(() => parseNumberFilter(params("min_signal=NaN"), "min_signal"));
  assert.equal(
    parseIsoFilter(params("after=2026-07-01T00%3A00%3A00Z"), "after"),
    "2026-07-01T00:00:00.000Z"
  );
  assert.throws(() => parseIsoFilter(params("after=yesterday"), "after"));
});
