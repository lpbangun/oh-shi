import assert from "node:assert/strict";
import test from "node:test";
import {
  retryCanonicalFetch,
  type CanonicalFetchSource,
} from "../lib/canonical-fetch-retry";

const source: CanonicalFetchSource = {
  provider: "recruitee",
  boardId: "acme",
};
const personioSource: CanonicalFetchSource = {
  provider: "personio",
  boardId: "acme.jobs.personio.com",
};
const workableSource: CanonicalFetchSource = {
  provider: "workable",
  boardId: "acme",
};
const smartRecruitersSource: CanonicalFetchSource = {
  provider: "smartrecruiters",
  boardId: "Acme",
};

function smartListItem(id: string) {
  const uuid = id === "one"
    ? "11111111-1111-4111-8111-111111111111"
    : "22222222-2222-4222-8222-222222222222";
  return {
    id,
    uuid,
    name: `Engineer ${id}`,
    company: { identifier: "Acme", name: "Acme" },
    releasedDate: "2026-07-30T12:00:00.000Z",
    location: {
      city: "Boston",
      region: "MA",
      country: "us",
      remote: false,
      hybrid: true,
      fullLocation: "Boston, MA, United States",
    },
    visibility: "PUBLIC",
    ref: `https://api.smartrecruiters.com/v1/companies/Acme/postings/${id}`,
  };
}

function smartDetail(id: string) {
  return {
    ...smartListItem(id),
    postingUrl: `https://jobs.smartrecruiters.com/Acme/${id}-engineer`,
    applyUrl: `https://jobs.smartrecruiters.com/Acme/${id}-engineer?oga=true`,
    jobAd: {
      sections: {
        jobDescription: {
          title: "Job Description",
          text: "<p>Build reliable systems.</p>",
        },
      },
    },
    active: true,
    department: { id: "engineering", label: "Engineering" },
    typeOfEmployment: { id: "permanent", label: "Full-time" },
  };
}

test("canonical adapters honor Retry-After for bounded 429 retries", async () => {
  let calls = 0;
  const waits: number[] = [];
  const fetcher: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "2" },
      });
    }
    return Response.json({ offers: [] });
  };
  const result = await retryCanonicalFetch(
    source,
    fetcher,
    3,
    async (milliseconds) => { waits.push(milliseconds); }
  );
  assert.equal(result.complete, true);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2_000]);
});

test("canonical adapters do not retry non-retryable or incomplete successful responses", async () => {
  let badRequestCalls = 0;
  await assert.rejects(
    retryCanonicalFetch(source, async () => {
      badRequestCalls += 1;
      return new Response("bad request", { status: 400 });
    }, 3, async () => undefined),
    /returned 400/
  );
  assert.equal(badRequestCalls, 1);

  let incompleteCalls = 0;
  await assert.rejects(
    retryCanonicalFetch(source, async () => {
      incompleteCalls += 1;
      return Response.json({ offers: [{ id: 1, title: "Missing action" }] });
    }, 3, async () => undefined),
    /incomplete payload/
  );
  assert.equal(incompleteCalls, 1);
});

test("Personio fetches bounded XML once and quarantines successful non-XML responses", async () => {
  const xml = `<workzag-jobs>
    <position>
      <id>42</id>
      <office>Remote - United States</office>
      <department>Engineering</department>
      <name>Platform Engineer</name>
      <jobDescriptions>
        <jobDescription><name>Role</name><value>Build reliable systems.</value></jobDescription>
      </jobDescriptions>
      <employmentType>permanent</employmentType>
      <schedule>full-time</schedule>
    </position>
  </workzag-jobs>`;
  let calls = 0;
  const result = await retryCanonicalFetch(personioSource, async (input) => {
    calls += 1;
    assert.equal(
      String(input),
      "https://acme.jobs.personio.com/xml?language=en"
    );
    return new Response(xml, { headers: { "content-type": "text/xml" } });
  });
  assert.equal(calls, 1);
  assert.equal(result.jobs[0].externalId, "42");

  let htmlCalls = 0;
  await assert.rejects(
    retryCanonicalFetch(personioSource, async () => {
      htmlCalls += 1;
      return new Response("<html>Sign in</html>", {
        headers: { "content-type": "text/html" },
      });
    }, 3, async () => undefined),
    /incomplete payload: non-XML response/
  );
  assert.equal(htmlCalls, 1);

  let oversizedCalls = 0;
  await assert.rejects(
    retryCanonicalFetch(personioSource, async () => {
      oversizedCalls += 1;
      return new Response("<workzag-jobs />", {
        headers: {
          "content-type": "text/xml",
          "content-length": "2000001",
        },
      });
    }, 3, async () => undefined),
    /incomplete payload: public_document_too_large/
  );
  assert.equal(oversizedCalls, 1);
});

test("Workable accepts only bounded complete JSON from its public account endpoint", async () => {
  const job = {
    shortcode: "ROLE123",
    title: "Platform Engineer",
    telecommuting: true,
    country: "United States",
    url: "https://apply.workable.com/j/ROLE123",
    application_url: "https://apply.workable.com/j/ROLE123/apply",
    published_on: "2026-07-30",
    description: "<p>Build reliable systems.</p>",
  };
  let calls = 0;
  const result = await retryCanonicalFetch(workableSource, async (input) => {
    calls += 1;
    assert.equal(
      String(input),
      "https://www.workable.com/api/accounts/acme?details=true"
    );
    return Response.json({ jobs: [job] });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.jobs.map((item) => item.externalId), ["ROLE123"]);

  let htmlCalls = 0;
  await assert.rejects(
    retryCanonicalFetch(workableSource, async () => {
      htmlCalls += 1;
      return new Response("<html>Sign in</html>", {
        headers: { "content-type": "text/html" },
      });
    }, 3, async () => undefined),
    /workable board acme returned an incomplete payload: non-JSON response/
  );
  assert.equal(htmlCalls, 1);

  let oversizedCalls = 0;
  await assert.rejects(
    retryCanonicalFetch(workableSource, async () => {
      oversizedCalls += 1;
      return new Response('{"jobs":[]}', {
        headers: {
          "content-type": "application/json",
          "content-length": "5000001",
        },
      });
    }, 3, async () => undefined),
    /workable board acme returned an incomplete payload: public_document_too_large/
  );
  assert.equal(oversizedCalls, 1);
});

test("SmartRecruiters paginates completely and retries only the throttled detail", async () => {
  const calls: string[] = [];
  let throttledDetailCalls = 0;
  const result = await retryCanonicalFetch(smartRecruitersSource, async (input) => {
    const url = new URL(String(input));
    calls.push(url.href);
    const segments = url.pathname.split("/").filter(Boolean);
    const postingId = segments[4];
    if (postingId === "two") {
      throttledDetailCalls += 1;
      if (throttledDetailCalls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return Response.json(smartDetail("two"));
    }
    if (postingId === "one") return Response.json(smartDetail("one"));
    const offset = Number(url.searchParams.get("offset"));
    return Response.json({
      offset,
      limit: 1,
      totalFound: 2,
      content: [smartListItem(offset === 0 ? "one" : "two")],
    });
  });
  assert.deepEqual(result.jobs.map((job) => job.externalId), ["one", "two"]);
  assert.equal(
    calls.filter((url) => new URL(url).pathname.endsWith("/postings")).length,
    2
  );
  assert.equal(throttledDetailCalls, 2);
  assert.equal(calls.length, 5);
});

test("SmartRecruiters rejects pagination drift before fetching any details", async () => {
  let calls = 0;
  await assert.rejects(
    retryCanonicalFetch(smartRecruitersSource, async (input) => {
      calls += 1;
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset"));
      return Response.json({
        offset,
        limit: 1,
        totalFound: offset === 0 ? 2 : 3,
        content: [smartListItem(offset === 0 ? "one" : "two")],
      });
    }),
    /incomplete payload.*total/i
  );
  assert.equal(calls, 2);
});
