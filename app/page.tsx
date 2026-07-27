import { DATA_AS_OF } from "@/lib/seed";
import { companyDeltas, facetValues, sectorStats } from "@/lib/derive";
import { listChanges, listCompanies, listJobs } from "@/lib/data";
import { JobBoard } from "./components/JobBoard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [companies, jobs, changes] = await Promise.all([
    listCompanies(),
    listJobs(true),
    listChanges(),
  ]);

  const deltaMap = companyDeltas(companies, jobs, changes);
  const sectors = sectorStats(companies, deltaMap);

  return (
    <JobBoard
      companies={companies}
      jobs={jobs}
      changes={changes}
      sectors={sectors}
      deltas={Object.fromEntries(deltaMap)}
      facets={facetValues(jobs)}
      dataAsOf={DATA_AS_OF}
    />
  );
}
