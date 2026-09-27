import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// Characterization captured from the pre-projection routes against the same
// seed corpus. Only the contract's clock fields are masked; changes_url is
// compared in full after interpolating its encoded incremental.after timestamp.
function golden(name: string) {
  return JSON.parse(readFileSync(path.join(process.cwd(), "e2e/goldens", name), "utf8"));
}

function defaultBytes(body: Record<string, unknown>, expected: Record<string, unknown>) {
  const actual = structuredClone(body) as Record<string, unknown>;
  const baseline = structuredClone(expected) as Record<string, unknown>;
  expect("generated_at" in actual).toBe(true);
  actual.generated_at = "<clock>";
  expect("cursor" in actual).toBe("cursor" in baseline);
  if ("cursor" in baseline) actual.cursor = "<clock>";
  if ("data_as_of" in baseline) {
    expect("data_as_of" in actual).toBe(true);
    actual.data_as_of = "<clock>";
  }
  if ("incremental" in baseline) {
    const incremental = actual.incremental as { after: string; changes_url: string };
    const expectedIncremental = baseline.incremental as { after: string; changes_url: string };
    expectedIncremental.changes_url = expectedIncremental.changes_url.replace(
      "<encoded-after>", encodeURIComponent(incremental.after)
    );
    incremental.after = "<clock>";
  }
  return [JSON.stringify(actual), JSON.stringify(baseline)];
}

test("no fields= preserves characterized jobs list bytes", async ({ request }) => {
  const response = await request.get("/api/v1/jobs?q=Capture&limit=2");
  expect(response.status()).toBe(200);
  const [actual, expected] = defaultBytes(await response.json(), golden("jobs-default.json"));
  expect(actual).toBe(expected);
});

test("no fields= preserves characterized job detail bytes", async ({ request }) => {
  const response = await request.get("/api/v1/jobs/job_cognition_capture");
  expect(response.status()).toBe(200);
  const [actual, expected] = defaultBytes(await response.json(), golden("job-detail-default.json"));
  expect(actual).toBe(expected);
});

test("no fields= preserves characterized intelligence jobs bytes", async ({ request }) => {
  const response = await request.get("/api/v1/intelligence?view=jobs&q=Capture&limit=2");
  expect(response.status()).toBe(200);
  const [actual, expected] = defaultBytes(await response.json(), golden("intelligence-jobs-default.json"));
  expect(actual).toBe(expected);
});

const core = ["id", "provider", "sourceId", "canonicalUrl", "title", "status", "summary"];

test("jobs list fields= projects only rows, retaining page and filters", async ({ request }) => {
  const base = await (await request.get("/api/v1/jobs?limit=2")).json();
  const coreOnly = await (await request.get("/api/v1/jobs?limit=2&fields=id,title")).json();
  const summary = await (await request.get("/api/v1/jobs?limit=2&fields=summary")).json();
  const full = await (await request.get("/api/v1/jobs?limit=2&fields=description,id")).json();
  expect(Object.keys(coreOnly.data[0])).toEqual(core);
  expect(Object.keys(summary.data[0])).toEqual(core);
  expect(Object.keys(full.data[0])).toEqual([...core, "description"]);
  expect(coreOnly.data[0].summary).toBe(base.data[0].summary);
  expect(coreOnly.data.map((job: { id: string }) => job.id)).toEqual(base.data.map((job: { id: string }) => job.id));
  expect(coreOnly.page).toEqual(base.page);
  expect(coreOnly.applied_filters).toEqual(base.applied_filters);
  expect(coreOnly.page.next_cursor).toMatch(/^v2\.jobs\.\d+$/);
  const next = await (await request.get(`/api/v1/jobs?limit=2&fields=id&cursor=${coreOnly.page.next_cursor}`)).json();
  const baseNext = await (await request.get(`/api/v1/jobs?limit=2&cursor=${base.page.next_cursor}`)).json();
  expect(next.page).toEqual(baseNext.page);
  expect(next.data.map((job: { id: string }) => job.id)).toEqual(baseNext.data.map((job: { id: string }) => job.id));
});

test("fields= list ETags distinguish token sets and honor 304", async ({ request }) => {
  const path = "/api/v1/jobs?q=Capture&limit=2";
  const base = await request.get(path);
  const id = await request.get(`${path}&fields=id`);
  const summary = await request.get(`${path}&fields=summary`);
  const description = await request.get(`${path}&fields=description,id`);
  const reversed = await request.get(`${path}&fields=id,description`);
  expect(new Set([base.headers().etag, id.headers().etag, summary.headers().etag, description.headers().etag]).size).toBe(4);
  expect(reversed.headers().etag).toBe(description.headers().etag);
  expect((await id.json()).data).toEqual((await summary.json()).data);
  const replay = await request.get(`${path}&fields=id`, { headers: { "If-None-Match": id.headers().etag } });
  expect(replay.status()).toBe(304);
  expect(replay.headers().etag).toBe(id.headers().etag);
  expect((await request.get(`${path}&fields=id`, { headers: { "If-None-Match": base.headers().etag } })).status()).toBe(200);
});

test("fields= rejects malformed vocabulary across jobs and dashboard", async ({ request }) => {
  for (const field of ["bogus", "excerpt", "company", "location", "", "id,,title", "id,"]) {
    for (const route of ["/api/v1/jobs", "/api/v1/jobs/job_cognition_capture"]) {
      const response = await request.get(`${route}?fields=${encodeURIComponent(field)}`);
      expect(response.status(), `${route}?fields=${field}`).toBe(400);
      expect((await response.json()).error).toBe("invalid_request");
    }
  }
  expect((await request.get("/api/v1/jobs?fields=id&fields=title")).status()).toBe(400);
  const dashboard = await request.get("/api/v1/dashboard/jobs?fields=title");
  expect(dashboard.status()).toBe(400);
  expect((await dashboard.json()).error).toBe("invalid_request");
  expect((await request.get("/api/v1/jobs?fields=%20id%2C%20title%20")).status()).toBe(200);
});

test("intelligence jobs fields= preserves envelope, row identity and cursor", async ({ request }) => {
  const path = "/api/v1/intelligence?view=jobs&limit=2";
  const plain = await (await request.get(path)).json();
  const projected = await (await request.get(`${path}&fields=id,title`)).json();
  expect(Object.keys(projected.data[0])).toEqual(core);
  expect(projected.data.map((row: { id: string }) => row.id)).toEqual(plain.data.map((row: { id: string }) => row.id));
  expect(projected.page).toEqual(plain.page);
  expect(projected.applied_filters).toEqual(plain.applied_filters);
  expect(projected.coverage).toEqual(plain.coverage);
  expect(projected.license).toEqual(plain.license);
  expect(projected.methodology_version).toEqual(plain.methodology_version);
  const envelopeBytes = (payload: typeof plain) => {
    const envelope = structuredClone(payload);
    delete envelope.data;
    delete envelope.generated_at;
    delete envelope.data_as_of;
    const after = envelope.incremental.after;
    // Changes URL is a deterministic encoding of the deleted clock field;
    // assert its entire shape and substitute only that derived value.
    expect(envelope.incremental.changes_url).toBe(`/api/v1/changes?after=${encodeURIComponent(after)}`);
    delete envelope.incremental.after;
    envelope.incremental.changes_url = "/api/v1/changes?after=<derived-from-after>";
    return JSON.stringify(envelope);
  };
  expect(envelopeBytes(projected)).toBe(envelopeBytes(plain));
  const next = await (await request.get(`${path}&fields=id&cursor=${projected.page.next_cursor}`)).json();
  const originalNext = await (await request.get(`${path}&cursor=${plain.page.next_cursor}`)).json();
  expect(next.page).toEqual(originalNext.page);
  expect(next.data.map((row: { id: string }) => row.id)).toEqual(originalNext.data.map((row: { id: string }) => row.id));
});

test("intelligence jobs fields= has distinct canonical ETags and fail-closed 400", async ({ request }) => {
  const path = "/api/v1/intelligence?view=jobs&q=Capture&limit=2";
  const base = await request.get(path);
  const id = await request.get(`${path}&fields=id`);
  const summary = await request.get(`${path}&fields=summary`);
  const description = await request.get(`${path}&fields=description,id`);
  const reverse = await request.get(`${path}&fields=id,description`);
  expect(new Set([base.headers().etag, id.headers().etag, summary.headers().etag, description.headers().etag]).size).toBe(4);
  expect(reverse.headers().etag).toBe(description.headers().etag);
  expect((await id.json()).data).toEqual((await summary.json()).data);
  const replay = await request.get(`${path}&fields=id`, { headers: { "If-None-Match": id.headers().etag } });
  expect(replay.status()).toBe(304);
  expect(replay.headers().etag).toBe(id.headers().etag);
  expect((await request.get(`${path}&fields=id`, { headers: { "If-None-Match": base.headers().etag } })).status()).toBe(200);
  for (const value of ["bogus", "excerpt", "company", "location", "", "id,,title"]) {
    const bad = await request.get(`${path}&fields=${encodeURIComponent(value)}`);
    expect(bad.status(), value).toBe(400);
    expect((await bad.json()).error).toBe("invalid_request");
    expect(bad.headers()["cache-control"]).toBe("no-store");
  }
});

test("job detail fields= preserves no-ETag behavior and ignores unrelated query", async ({ request }) => {
  const path = "/api/v1/jobs/job_cognition_capture";
  const base = await request.get(path);
  const unrelated = await request.get(`${path}?unrelated=1`);
  const projected = await request.get(`${path}?fields=id`, { headers: { "If-None-Match": 'W/"irrelevant"' } });
  expect(projected.status()).toBe(200);
  expect(projected.headers().etag).toBeUndefined();
  expect(base.headers().etag).toBeUndefined();
  expect(unrelated.headers().etag).toBeUndefined();
  expect(Object.keys((await projected.json()).data)).toEqual(core);
  expect((await base.json()).data).toEqual((await unrelated.json()).data);
});
