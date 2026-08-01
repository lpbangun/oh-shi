import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildStartupDomainPilot,
  registrableDomain,
  type StartupDomainEvidenceInput,
} from "../lib/domain-registry";
import {
  YC_SOURCE_KIND,
  fetchYcDirectory,
  ycEvidenceInputs,
} from "../lib/startup-directory";

const ENDPOINT = "https://query.wikidata.org/sparql";
const TERMS_URL = "https://www.wikidata.org/wiki/Wikidata:Copyright";
const COHORT = "startup-directory-2026-08-01";
const TARGET_DOMAINS = 25_000;
const MINIMUM_DOMAINS = 2_000;
const USER_AGENT = "OH-SHI/1.0 startup-domain-pilot (https://ohshi.work/about)";

const QUERIES = [
  {
    id: "explicit-startup",
    classification: "explicit_startup",
    query: `SELECT ?company ?companyLabel ?website WHERE {
      ?company wdt:P31/wdt:P279* wd:Q129238;
        wdt:P856 ?website.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } ORDER BY ?company ?website LIMIT 500`,
  },
  {
    id: "recent-software-candidate",
    classification: "recent_software_candidate",
    query: `SELECT ?company ?companyLabel ?website ?inception WHERE {
      ?company wdt:P31 wd:Q1058914;
        wdt:P856 ?website;
        wdt:P571 ?inception.
      FILTER(YEAR(?inception) >= 2015)
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } ORDER BY ?company ?website LIMIT 500`,
  },
] as const;

type Binding = {
  company?: { value?: string };
  companyLabel?: { value?: string };
  website?: { value?: string };
};

async function queryWikidata(query: string) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  const response = await fetch(url, {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Wikidata query failed with HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    results?: { bindings?: Binding[] };
  };
  return payload.results?.bindings || [];
}

function qid(value: string) {
  const match = value.match(/\/(Q\d+)$/);
  return match?.[1] || "";
}

function canonicalWebsite(websites: string[]) {
  return [...new Set(websites)].filter((value) => {
    try {
      return new URL(value).protocol === "https:" && Boolean(registrableDomain(value));
    } catch {
      return false;
    }
  }).sort((left, right) => {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.pathname.length - rightUrl.pathname.length ||
      leftUrl.hostname.length - rightUrl.hostname.length ||
      left.localeCompare(right)
    );
  });
}

async function main() {
  const observedAt = new Date().toISOString();
  const entities = new Map<string, {
    companyName: string;
    websites: string[];
    classification: string;
  }>();
  const sourceReceipts: Array<{ id: string; rows: number }> = [];
  for (const source of QUERIES) {
    const rows = await queryWikidata(source.query);
    sourceReceipts.push({ id: source.id, rows: rows.length });
    for (const row of rows) {
      const entityId = qid(row.company?.value || "");
      const website = row.website?.value || "";
      if (!entityId || !website) continue;
      const current = entities.get(entityId) || {
        companyName: row.companyLabel?.value || entityId,
        websites: [],
        classification: source.classification,
      };
      current.websites.push(website);
      if (source.classification === "explicit_startup") {
        current.classification = source.classification;
      }
      entities.set(entityId, current);
    }
  }
  const inputs: StartupDomainEvidenceInput[] = [];
  for (const [entityId, entity] of [...entities.entries()].sort()) {
    const websites = canonicalWebsite(entity.websites);
    if (!websites.length) continue;
    inputs.push({
      companyName: entity.companyName,
      websiteUrl: websites[0],
      observedWebsiteUrls: websites.slice(1),
      sourceId: entityId,
      sourceKind: "wikidata",
      sourceClassification: entity.classification,
      evidenceUrl: `https://www.wikidata.org/wiki/${entityId}`,
      permissionStatus: "permitted",
      sourceTermsUrl: TERMS_URL,
      observedAt,
      activityState: "unknown",
      reviewStatus: "pending",
    });
  }
  // Wikidata alone yields a cohort of large, long-established companies. The YC
  // directory supplies the actual startup universe, so it is the primary source
  // and Wikidata is retained only as supplementary evidence.
  const ycCompanies = await fetchYcDirectory();
  const ycInputs = ycEvidenceInputs(ycCompanies, observedAt);
  sourceReceipts.push({ id: YC_SOURCE_KIND, rows: ycInputs.length });
  inputs.push(...ycInputs);

  const pilot = buildStartupDomainPilot(inputs, TARGET_DOMAINS, COHORT);
  if (pilot.entries.length < MINIMUM_DOMAINS) {
    throw new Error(
      `Expected at least ${MINIMUM_DOMAINS} distinct domains, received ${pilot.entries.length}`
    );
  }
  const records: StartupDomainEvidenceInput[] = pilot.entries.flatMap((entry) =>
    entry.evidence.map((evidence, index) => ({
      companyName: entry.companyName,
      websiteUrl: entry.websiteUrl,
      observedWebsiteUrls: evidence.observedWebsiteUrls,
      aliases: index === 0 ? entry.aliases.map((alias) => ({
        ...alias,
        sourceTermsUrl: alias.sourceTermsUrl || undefined,
      })) : [],
      acquisitions: index === 0 ? entry.acquisitions.map((acquisition) => ({
        ...acquisition,
        sourceTermsUrl: acquisition.sourceTermsUrl || undefined,
      })) : [],
      sourceId: evidence.sourceId,
      sourceKind: evidence.sourceKind,
      sourceClassification: evidence.sourceClassification,
      evidenceUrl: evidence.evidenceUrl,
      permissionStatus: evidence.permissionStatus,
      sourceTermsUrl: evidence.sourceTermsUrl || undefined,
      observedAt: evidence.observedAt,
      activityState: entry.activityState,
      reviewStatus: entry.reviewStatus,
    }))
  );
  const output = {
    schemaVersion: "1.0",
    cohort: COHORT,
    generatedAt: observedAt,
    license:
      "Wikidata structured-data evidence is CC0; the YC directory mirror is MIT-licensed; linked websites retain their own rights.",
    activation: "none",
    source: {
      endpoint: ENDPOINT,
      termsUrl: TERMS_URL,
      queries: QUERIES,
      receipts: sourceReceipts,
    },
    receipt: pilot.receipt,
    records,
  };
  const argument = process.argv.find((value) => value.startsWith("--output="));
  const destination = path.resolve(
    argument?.slice("--output=".length) || "outputs/startup-domain-pilot.json"
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    destination,
    cohort: COHORT,
    sourceReceipts,
    receipt: pilot.receipt,
    records: records.length,
    activation: "none",
  }, null, 2));
}

await main();
