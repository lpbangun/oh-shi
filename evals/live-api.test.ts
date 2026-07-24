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
        headers: { "User-Agent": "OH-SHI-Evals/1.0" },
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

test("public site and agent discovery surfaces are reachable", async () => {
  const paths = ["/", "/llms.txt", "/agent-policy.json", "/robots.txt"];
  for (const path of paths) {
    const response = await get(path);
    assert.ok((await response.text()).length > 20, `${path} must not be empty`);
  }
});

test("live job feed is current and preserves canonical context", async () => {
  const payload = await (await get("/api/v1/jobs")).json() as {
    schema_version: string;
    generated_at: string;
    cursor: string;
    data: Array<{
      status: string;
      canonicalUrl: string;
      company?: { id: string; name: string };
    }>;
  };
  assert.equal(payload.schema_version, "1.0");
  assert.ok(Date.now() - Date.parse(payload.generated_at) < 10 * 60 * 1000);
  assert.ok(payload.data.length >= 8);
  for (const job of payload.data) {
    assert.equal(job.status, "verified_open");
    assert.match(job.canonicalUrl, /^https:\/\//);
    assert.ok(job.company?.id && job.company.name);
  }
});

test("live company and change feeds satisfy their envelopes", async () => {
  for (const path of ["/api/v1/companies", "/api/v1/changes"]) {
    const payload = await (await get(path)).json() as {
      schema_version: string;
      generated_at: string;
      data: unknown[];
    };
    assert.equal(payload.schema_version, "1.0");
    assert.ok(Array.isArray(payload.data) && payload.data.length > 0);
    assert.ok(Date.now() - Date.parse(payload.generated_at) < 10 * 60 * 1000);
  }
});
