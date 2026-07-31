import assert from "node:assert/strict";
import test from "node:test";
import { probeCanonicalSource } from "../lib/canonical-source-discovery";

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

test("canonical source probe caches robots and follows one bounded career path", async () => {
  let robotsRequests = 0;
  const requested: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(url.href);
    if (url.pathname === "/robots.txt") {
      robotsRequests += 1;
      return html("User-agent: *\nAllow: /");
    }
    if (url.pathname === "/") {
      return html('<a href="/company/openings">View openings</a>');
    }
    if (url.pathname === "/company/openings") {
      return html('<a href="https://jobs.ashbyhq.com/acme/job-1">Apply</a>');
    }
    return html("Not found", 404);
  }) as typeof fetch;
  const result = await probeCanonicalSource("https://acme.example/", {
    fetcher,
    includeStructured: false,
    maxPages: 6,
  });
  assert.equal(result.detectionStatus, "single");
  assert.deepEqual(result.detection, {
    provider: "ashby",
    boardId: "acme",
    careersUrl: "https://jobs.ashbyhq.com/acme",
  });
  assert.equal(robotsRequests, 1);
  assert.ok(requested.includes("https://acme.example/company/openings"));
  assert.equal(result.pages.length, 6);
});

test("canonical source probe records but never fetches unsupported external career links", async () => {
  const requested: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(url.href);
    assert.equal(url.hostname, "acme.example", "external career hosts must remain unfetched");
    if (url.pathname === "/robots.txt") return html("User-agent: *\nAllow: /");
    if (url.pathname === "/") {
      return html(`
        <a href="https://careers.unknown-ats.test/acme/jobs?token=secret">Jobs</a>
        <a href="https://careers.unknown-ats.test/acme/jobs/second?ref=public">More jobs</a>
        <a href="https://unrelated.test/about">About</a>
      `);
    }
    return html("Not found", 404);
  }) as typeof fetch;
  const result = await probeCanonicalSource("https://acme.example/", {
    fetcher,
    includeStructured: false,
  });
  assert.deepEqual(result.externalCareerLinks, [{
    host: "careers.unknown-ats.test",
    registrableDomain: "unknown-ats.test",
    evidencePages: ["https://acme.example/"],
    occurrenceCount: 2,
    signals: ["jobs_path"],
    sampleUrls: [
      "https://careers.unknown-ats.test/acme/jobs",
      "https://careers.unknown-ats.test/acme/jobs/second",
    ],
  }]);
  assert.ok(requested.every((url) => new URL(url).hostname === "acme.example"));
});

test("canonical source probe reports multiple boards as ambiguous", async () => {
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") return html("");
    if (url.pathname === "/") {
      return html(`
        <a href="https://jobs.lever.co/acme/role-1">Engineering</a>
        <a href="https://jobs.ashbyhq.com/unrelated/role-2">Partner jobs</a>
      `);
    }
    return html("Not found", 404);
  }) as typeof fetch;
  const result = await probeCanonicalSource("https://acme.example/", {
    fetcher,
    includeStructured: false,
  });
  assert.equal(result.detection, null);
  assert.equal(result.detectionStatus, "ambiguous");
  assert.deepEqual(
    result.candidates.map((item) => `${item.provider}:${item.boardId}`),
    ["ashby:unrelated", "lever:acme"]
  );
});

test("canonical source probe preserves robots failures instead of treating them as no source", async () => {
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") {
      return html("User-agent: *\nDisallow: /");
    }
    throw new Error("content request should have been blocked");
  }) as typeof fetch;
  const result = await probeCanonicalSource("https://blocked.example/", {
    fetcher,
    includeStructured: false,
  });
  assert.equal(result.detectionStatus, "none");
  assert.equal(result.pages.length, 5);
  assert.ok(result.pages.every(
    (page) =>
      page.status === "robots_or_network_error" &&
      page.error === "robots_policy_disallows_discovery"
  ));
});
