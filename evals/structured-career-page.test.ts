import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverStructuredCareerSource,
  fetchStructuredCareerSource,
  parseStructuredCareerPage,
} from "../lib/structured-career-page";
import {
  boundedText,
  robotsAllows,
  sitemapUrlsFromRobots,
  urlsFromSitemap,
} from "../lib/public-web";

const detailHtml = (validThrough = "2026-08-31T00:00:00Z") => `
<!doctype html>
<html><body>
<script type="application/ld+json">
${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "JobPosting",
  identifier: { "@type": "PropertyValue", value: "REQ-42" },
  title: "Senior Platform Engineer",
  description: "<p>Build reliable systems for a distributed product team.</p>",
  hiringOrganization: {
    "@type": "Organization",
    name: "Example",
    sameAs: "https://example.com/",
  },
  jobLocationType: "TELECOMMUTE",
  applicantLocationRequirements: {
    "@type": "Country",
    address: { addressCountry: "US" },
  },
  employmentType: "FULL_TIME",
  datePosted: "2026-07-29",
  validThrough,
  url: "https://example.com/careers/req-42",
})}
</script>
<a class="apply-button" href="https://example.com/careers/req-42/apply">Apply now</a>
</body></html>`;

test("structured JobPosting requires an actionable, current, US first-party role", () => {
  const jobs = parseStructuredCareerPage(
    detailHtml(),
    "https://example.com/careers/req-42",
    "2026-07-30T00:00:00.000Z"
  );
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], {
    externalId: "REQ-42",
    title: "Senior Platform Engineer",
    roleFamily: "Engineering",
    location: "US",
    remoteStatus: "Remote",
    employmentType: "FULL_TIME",
    compensation: "See posting",
    canonicalUrl: "https://example.com/careers/req-42",
    publishedAt: "2026-07-29T00:00:00.000Z",
    summary: "Build reliable systems for a distributed product team.",
  });
  assert.equal(
    parseStructuredCareerPage(
      detailHtml("2026-07-29T00:00:00Z"),
      "https://example.com/careers/req-42",
      "2026-07-30T00:00:00.000Z"
    ).length,
    0
  );
  assert.equal(
    parseStructuredCareerPage(
      detailHtml().replace(/<a class="apply-button"[\s\S]*?<\/a>/, ""),
      "https://example.com/careers/req-42",
      "2026-07-30T00:00:00.000Z"
    ).length,
    0
  );
  assert.throws(
    () => parseStructuredCareerPage(
      `<script type="application/ld+json">{bad json</script>`,
      "https://example.com/careers/bad"
    ),
    /incomplete payload/
  );
});

test("semantic career detail fallback requires title, apply action, requisition, and US evidence", () => {
  const html = `<html><body>
    <h1 class="job-title">Applied AI Engineer</h1>
    <div class="job-post-location">Remote US</div>
    <p>${"Build useful, safe machine learning products. ".repeat(12)}</p>
    <p>Req ID: R3070</p>
    <a href="/careers/apply/R3070">Apply Now</a>
  </body></html>`;
  const jobs = parseStructuredCareerPage(
    html,
    "https://example.com/careers/position/R3070",
    "2026-07-30T00:00:00.000Z"
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].externalId, "R3070");
  assert.equal(jobs[0].location, "Remote US");
  assert.equal(jobs[0].remoteStatus, "Remote");
  assert.equal(
    parseStructuredCareerPage(
      html.replace("Remote US", "Remote Canada"),
      "https://example.com/careers/position/R3070"
    ).length,
    0
  );
});

test("robots, sitemap parsing, and the structured crawl stay bounded and first-party", async () => {
  const robots = `User-agent: *
Disallow: /careers/private
Allow: /careers/private/public
Sitemap: https://example.com/careers-sitemap.xml`;
  assert.equal(robotsAllows(robots, "/careers/private/secret"), false);
  assert.equal(robotsAllows(robots, "/careers/private/public/role"), true);
  assert.deepEqual(sitemapUrlsFromRobots(robots), [
    "https://example.com/careers-sitemap.xml",
  ]);
  assert.deepEqual(urlsFromSitemap(
    `<urlset><url><loc>https://example.com/careers/req-42?a=1&amp;b=2</loc></url></urlset>`
  ), ["https://example.com/careers/req-42?a=1&b=2"]);

  const bodies = new Map<string, { status?: number; body: string }>([
    ["https://example.com/robots.txt", { body: robots }],
    ["https://example.com/careers-sitemap.xml", {
      body: `<urlset><url><loc>https://example.com/careers/req-42</loc></url></urlset>`,
    }],
    ["https://example.com/careers", {
      body: `<a href="/careers/req-42">Platform role</a><a href="https://evil.example/jobs/1">Off site</a>`,
    }],
    ["https://example.com/careers/", {
      body: `<a href="/careers/req-42">Platform role</a>`,
    }],
    ["https://example.com/careers/req-42", { body: detailHtml() }],
  ]);
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    requested.push(url);
    const fixture = bodies.get(url);
    return new Response(fixture?.body || "", {
      status: fixture?.status || (fixture ? 200 : 404),
      headers: { "content-type": "text/html" },
    });
  };
  assert.deepEqual(await discoverStructuredCareerSource(
    "https://example.com/",
    fetcher,
    "2026-07-30T00:00:00.000Z"
  ), {
    provider: "structured",
    boardId: "https://example.com/careers",
    careersUrl: "https://example.com/careers",
  });
  const refreshed = await fetchStructuredCareerSource(
    "https://example.com/careers",
    fetcher,
    "2026-07-30T00:00:00.000Z"
  );
  assert.equal(refreshed.complete, true);
  assert.equal(refreshed.jobs.length, 1);
  assert.equal(requested.some((url) => url.startsWith("https://evil.example")), false);
  assert.ok(requested.length < 30);
  await assert.rejects(
    fetchStructuredCareerSource(
      "https://example.com/careers/missing",
      fetcher,
      "2026-07-30T00:00:00.000Z"
    ),
    /incomplete payload: required page 404/
  );

  await assert.rejects(
    boundedText(new Response("x".repeat(11), {
      headers: { "content-length": "11" },
    }), 10),
    /too_large/
  );
});
