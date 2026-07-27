import assert from "node:assert/strict";
import test from "node:test";

const base =
  process.env.OH_SHI_BASE_URL ||
  "https://oh-shi-intelligence.logsam-fans-triple3.chatgpt.site";

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function get(path: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { "User-Agent": "OH-SHI-Evals/1.1" },
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 200, `${path} must return 200`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 500);
    }
  }
  throw lastError;
}

async function json<T>(path: string) {
  return (await (await get(path)).json()) as T;
}

type Page = {
  limit: number;
  returned: number;
  next_cursor: string | null;
  total: number;
};

type Receipt = {
  value: number;
  methodologyVersion: string;
  components: Array<{ points: number; max: number }>;
};

test("public site and agent discovery surfaces are reachable", async () => {
  for (const path of ["/", "/llms.txt", "/agent-policy.json", "/robots.txt"]) {
    const response = await get(path);
    assert.ok((await response.text()).length > 20, `${path} must not be empty`);
  }
});

test("preferred intelligence endpoint advertises all supported views", async () => {
  const payload = await json<{
    schema_version: string;
    view: string;
    data: { preferred_entrypoint: string; views: Record<string, unknown> };
  }>("/api/v1/intelligence");
  assert.equal(payload.schema_version, "1.1");
  assert.equal(payload.view, "capabilities");
  assert.equal(payload.data.preferred_entrypoint, "/api/v1/intelligence");
  assert.deepEqual(Object.keys(payload.data.views).sort(), [
    "companies",
    "jobs",
    "movements",
    "sectors",
  ]);
});

test("live job records are recently verified and preserve canonical context", async () => {
  const payload = await json<{
    schema_version: string;
    page: Page;
    data: Array<{
      id: string;
      status: string;
      canonicalUrl: string;
      lastVerifiedAt: string;
      company?: { id: string; name: string };
    }>;
  }>("/api/v1/intelligence?view=jobs&status=verified_open&limit=100");
  assert.equal(payload.schema_version, "1.1");
  assert.ok(payload.page.total >= 12);
  assert.ok(
    Date.now() - Math.max(...payload.data.map((job) => Date.parse(job.lastVerifiedAt))) <
      26 * 60 * 60 * 1000,
    "at least one returned record must come from the latest daily refresh"
  );
  for (const job of payload.data) {
    assert.equal(job.status, "verified_open");
    assert.match(job.canonicalUrl, /^https:\/\//);
    assert.ok(job.company?.id && job.company.name);
  }
});

test("company pagination, filters, and score receipts agree with published totals", async () => {
  type CompanyRecord = {
    id: string;
    sector: string;
    hiringScore: number;
    evidenceConfidence: number;
    signal: Receipt;
    confidence: Receipt;
  };
  const first = await json<{ page: Page; data: CompanyRecord[] }>(
    "/api/v1/intelligence?view=companies"
  );
  assert.equal(first.page.limit, 10);
  assert.equal(first.data.length, 10);
  assert.ok(first.page.total >= 12);
  assert.ok(first.page.next_cursor);

  const company = first.data[0];
  assert.equal(company.signal.value, company.hiringScore);
  assert.equal(company.confidence.value, company.evidenceConfidence);
  for (const receipt of [company.signal, company.confidence]) {
    assert.ok(receipt.methodologyVersion);
    assert.equal(
      Math.round(receipt.components.reduce((sum, component) => sum + component.points, 0)),
      receipt.value
    );
    assert.ok(
      receipt.components.every(
        (component) => component.points >= 0 && component.points <= component.max
      )
    );
  }

  const second = await json<{ page: Page; data: CompanyRecord[] }>(
    `/api/v1/intelligence?view=companies&cursor=${encodeURIComponent(first.page.next_cursor!)}`
  );
  assert.ok(second.data.length > 0 && second.data.length <= 10);
  assert.equal(
    new Set([...first.data, ...second.data].map((item) => item.id)).size,
    first.data.length + second.data.length
  );

  const filtered = await json<{ data: CompanyRecord[] }>(
    `/api/v1/intelligence?view=companies&sector=${encodeURIComponent(company.sector)}`
  );
  assert.ok(filtered.data.length > 0);
  assert.ok(filtered.data.every((item) => item.sector === company.sector));
});

test("movement aggregation and funding pagination return evidence", async () => {
  type Movement = {
    id: string;
    type: string;
    evidenceCount: number;
    sourceUrls: string[];
  };
  const grouped = await json<{ page: Page; data: Movement[] }>(
    "/api/v1/intelligence?view=movements&group=company_day"
  );
  assert.ok(grouped.data.length > 0);
  assert.ok(grouped.data.length <= 25);
  assert.ok(
    grouped.data.every(
      (item) =>
        item.id &&
        item.evidenceCount > 0 &&
        item.sourceUrls.length > 0 &&
        item.sourceUrls.every((url) => /^https:\/\//.test(url))
    )
  );

  const funding = await json<{ page: Page; data: Movement[] }>(
    "/api/v1/intelligence?view=movements&type=funding&limit=10"
  );
  assert.equal(funding.page.limit, 10);
  assert.ok(funding.data.every((item) => item.type === "funding"));
});

test("invalid intelligence filters fail closed", async () => {
  const response = await fetch(
    `${base}/api/v1/intelligence?view=companies&unknown_filter=ignored`,
    { signal: AbortSignal.timeout(15_000) }
  );
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error: string };
  assert.equal(payload.error, "invalid_request");
});
