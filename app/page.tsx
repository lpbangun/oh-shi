import { DATA_AS_OF } from "@/lib/seed";
import {
  companyDayMovements,
  companyDeltas,
  facetValues,
  sectorDayMovements,
  sectorStats,
} from "@/lib/derive";
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
  const companyIdByJobId = new Map(jobs.map((job) => [job.id, job.companyId]));
  const sectorMovements = sectorDayMovements(companies, jobs, changes).filter(
    (movement) =>
      new Set(
        movement.jobs
          .map((job) => companyIdByJobId.get(job.id))
          .filter((companyId): companyId is string => Boolean(companyId))
      ).size > 1
  );
  const movements = [
    ...companyDayMovements(companies, jobs, changes),
    ...sectorMovements,
  ].sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      Math.abs(b.netChange) - Math.abs(a.netChange) ||
      a.id.localeCompare(b.id)
  );

  return (
    <JobBoard
      companies={companies}
      jobs={jobs}
      changes={changes}
      sectors={sectors}
      movements={movements}
      deltas={Object.fromEntries(deltaMap)}
      facets={facetValues(jobs)}
      dataAsOf={DATA_AS_OF}
    />
  );
}
