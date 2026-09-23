import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { probeAtsBySlug, slugCandidates } from "../lib/ats-slug-probe";
import { DISCOVERY_PIPELINE_VERSION } from "../lib/discovery-version";

/**
 * Slug corroboration for registry-evidence board ids — the user-approved
 * remediation (2026-09-23, second decision, `AGENTS.md` "User-approved
 * remediation" (d)).
 *
 * The ATS slug probe refuses a non-greenhouse slug that does not equal the
 * registrable domain label; that is what keeps a slug collision (a different
 * employer owning the same board slug) from being activated as if it were the
 * candidate. The corrected cohort evidence ids for the subdomain-keyed families
 * (`curated:demodesk-gmbh` from `demodesk-gmbh.jobs.personio.de`,
 * `curated:bunq` from `bunq.recruitee.com`) carry the employer's own board id,
 * which by design differs from the domain label (`demodeskgmbh` != `demodesk`),
 * so the probe could never retry the real board (measured:
 * `evidence/cohorts/remediation/personio-slug-probe.json`, 53 fetches, null).
 *
 * The approved relaxation is exactly one case: a slug the candidate's own
 * registry evidence recorded may bypass the domain-label equality check on the
 * two vendor hosts that key the board by that slug
 * (`<slug>.jobs.personio.de|.com`, `<slug>.recruitee.com`), and only once the
 * payload has passed the adapter's normal completeness gate. Label-derived
 * slugs and every other family keep the guard byte-unchanged.
 *
 * The characterization tests below started green against the pre-fix code;
 * the relaxation's own tests land with its fix.
 */

const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), "utf8");

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function xmlResponse(body: string) {
  return new Response(body, { headers: { "content-type": "application/xml" } });
}

function notFound() {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

/** Serves exactly the routes given and 404s everything else (robots included). */
function routeFetcher(routes: Record<string, () => Response>) {
  return (async (input: string | URL | Request) => {
    const route = routes[String(input)];
    return route ? route() : notFound();
  }) as typeof fetch;
}

function greenhouseJobs() {
  return {
    jobs: [{
      id: 101,
      title: "Platform Engineer",
      absolute_url: "https://boards.greenhouse.io/acme-gmbh/jobs/101",
    }],
  };
}

function leverJobs() {
  return [{
    id: "lev-1",
    text: "Platform Engineer",
    hostedUrl: "https://jobs.lever.co/acme-gmbh/lev-1",
  }];
}

function ashbyJobs() {
  return {
    jobs: [{
      id: "ash-1",
      title: "Platform Engineer",
      jobUrl: "https://jobs.ashbyhq.com/acme-gmbh/ash-1",
    }],
  };
}

/** A complete recruitee board: published offer with both HTTPS URLs. */
function recruiteeOffers() {
  return {
    offers: [{
      id: 7,
      title: "Platform Engineer",
      status: "published",
      department: "Engineering",
      careers_url: "https://acme-gmbh.recruitee.com/o/platform-engineer",
      careers_apply_url: "https://acme-gmbh.recruitee.com/o/platform-engineer/c/new",
      locations: [{ name: "Remote - United States" }],
    }],
  };
}

/** A complete personio board payload — `parsePersonioPositions` accepts it. */
const PERSONIO_XML = `<workzag-jobs>
  <position>
    <id>421</id>
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

// ---------------------------------------------------------------------------
// Characterization — the refusals that must not move
// ---------------------------------------------------------------------------

test("label-derived probes stay scoped to the domain label for every family", async () => {
  // Every family exposes a complete public board under the alias slug
  // `acme-gmbh` (the real demodesk shape). A probe driven by the registrable
  // domain label alone (`acme`) must never reach any of them — before or after
  // the corroboration change.
  const routes = {
    "https://boards-api.greenhouse.io/v1/boards/acme-gmbh/jobs?content=true":
      () => jsonResponse(greenhouseJobs()),
    "https://boards-api.greenhouse.io/v1/boards/acme-gmbh":
      () => jsonResponse({ name: "Acme" }),
    "https://api.lever.co/v0/postings/acme-gmbh?mode=json":
      () => jsonResponse(leverJobs()),
    "https://api.ashbyhq.com/posting-api/job-board/acme-gmbh":
      () => jsonResponse(ashbyJobs()),
    "https://www.workable.com/api/accounts/acme-gmbh?details=true":
      () => jsonResponse({ jobs: [] }),
    "https://acme-gmbh.recruitee.com/api/offers/":
      () => jsonResponse(recruiteeOffers()),
    "https://acme-gmbh.jobs.personio.de/xml?language=en":
      () => xmlResponse(PERSONIO_XML),
    "https://acme-gmbh.jobs.personio.com/xml?language=en":
      () => xmlResponse(PERSONIO_XML),
  };
  assert.equal(
    await probeAtsBySlug("acme.com", "Acme", { fetcher: routeFetcher(routes) }),
    null
  );

  // The candidate set itself is unchanged: the label alone, plus the label's
  // hyphenless form when the label has hyphens (which satisfies the same guard,
  // since the guard compares the hyphenless forms).
  assert.deepEqual(slugCandidates("acme.com"), ["acme"]);
  assert.deepEqual(slugCandidates("acme-gmbh.com"), ["acme-gmbh", "acmegmbh"]);

  // Control: a hyphenated *label* already names the vendor host without any
  // relaxation — that path must keep working untouched.
  const labelRoutes = {
    "https://acme-gmbh.jobs.personio.de/xml?language=en":
      () => xmlResponse(PERSONIO_XML),
  };
  assert.deepEqual(
    await probeAtsBySlug("acme-gmbh.com", "Acme GmbH", {
      fetcher: routeFetcher(labelRoutes),
    }),
    {
      provider: "personio",
      boardId: "acme-gmbh.jobs.personio.de",
      careersUrl: "https://acme-gmbh.jobs.personio.de/",
      confirmedBy: "board_url",
    }
  );
});

test("evidence-derived aliases keep the guard for the other families", async () => {
  // lever, ashby, and workable do not expose a trustworthy employer identity,
  // so an evidence slug that is not the domain label still cannot activate
  // them: the relaxation covers the two vendor hosts keyed by the slug only.
  const guardRoutes = {
    "https://api.lever.co/v0/postings/acme-inc?mode=json":
      () => jsonResponse(leverJobs()),
    "https://api.ashbyhq.com/posting-api/job-board/acme-inc":
      () => jsonResponse(ashbyJobs()),
    "https://www.workable.com/api/accounts/acme-inc?details=true":
      () => jsonResponse({ jobs: [] }),
  };
  for (const provider of ["lever", "ashby", "workable"] as const) {
    assert.equal(
      await probeAtsBySlug("acme.com", "Acme", {
        fetcher: routeFetcher(guardRoutes),
        extraSlugs: ["acme-inc"],
      }),
      null,
      `${provider} must keep the domain-label guard`
    );
  }

  // Greenhouse keeps its own corroboration rule — the board itself names the
  // employer — which this change does not touch: it resolves when the name
  // matches and refuses when it does not.
  const greenhouseRoutes = (boardName: string) => ({
    "https://boards-api.greenhouse.io/v1/boards/acme-inc/jobs?content=true":
      () => jsonResponse(greenhouseJobs()),
    "https://boards-api.greenhouse.io/v1/boards/acme-inc":
      () => jsonResponse({ name: boardName }),
  });
  assert.deepEqual(
    await probeAtsBySlug("acme.com", "Acme", {
      fetcher: routeFetcher(greenhouseRoutes("Acme")),
      extraSlugs: ["acme-inc"],
    }),
    {
      provider: "greenhouse",
      boardId: "acme-inc",
      careersUrl: "https://job-boards.greenhouse.io/acme-inc",
      confirmedBy: "board_name",
    }
  );
  assert.equal(
    await probeAtsBySlug("acme.com", "Acme", {
      fetcher: routeFetcher(greenhouseRoutes("Unrelated Employer")),
      extraSlugs: ["acme-inc"],
    }),
    null
  );
});

test("an evidence-derived slug resolves only on a complete validated payload", async () => {
  // The relaxation is downstream of the adapter's completeness gate, so a
  // vendor host that answers with an incomplete payload resolves nothing. The
  // personio probe only reads XML, and the recruitee completeness gate requires
  // published offers with both HTTPS URLs.
  const incomplete = routeFetcher({
    "https://acme-gmbh.jobs.personio.de/xml?language=en":
      () => xmlResponse("<html>Sign in</html>"),
    "https://acme-gmbh.jobs.personio.com/xml?language=en":
      () => xmlResponse("<workzag-jobs><position><name>no id</name></position></workzag-jobs>"),
    "https://acme-gmbh.recruitee.com/api/offers/":
      () => jsonResponse({ offers: [{ id: 1, title: "Platform Engineer" }] }),
  });
  for (const domain of ["acme.com", "acme-gmbh.com"]) {
    assert.equal(
      await probeAtsBySlug(domain, "Acme", {
        fetcher: incomplete,
        extraSlugs: ["acme-gmbh"],
      }),
      null,
      `${domain}: an incomplete vendor payload must not resolve`
    );
  }
});
