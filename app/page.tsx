import { DATA_AS_OF } from "@/lib/seed";
import {
  companyDayMovements,
  companyDeltas,
  fundingMovements,
  sectorDayMovements,
  sectorStats,
} from "@/lib/derive";
import {
  getHomepageData,
} from "@/lib/data";
import { JobBoard } from "./components/JobBoard";

export const dynamic = "force-dynamic";

const HOMEPAGE_CHANGE_LIMIT = 250;
const HOMEPAGE_JOB_LIMIT = 100;
const HOMEPAGE_MOVEMENT_LIMIT = 100;

export default async function Home() {
  const { companies, jobs, movementJobs, changes, coverage } = await getHomepageData();

  const deltaMap = companyDeltas(companies, movementJobs, changes);
  const sectors = sectorStats(companies, deltaMap);
  const companyIdByJobId = new Map(movementJobs.map((job) => [job.id, job.companyId]));
  const sectorMovements = sectorDayMovements(companies, movementJobs, changes).filter(
    (movement) =>
      new Set(
        movement.jobs
          .map((job) => companyIdByJobId.get(job.id))
          .filter((companyId): companyId is string => Boolean(companyId))
      ).size > 1
  );
  const movements = [
    ...fundingMovements(companies, changes),
    ...companyDayMovements(companies, movementJobs, changes),
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
      jobs={jobs.slice(0, HOMEPAGE_JOB_LIMIT)}
      changes={changes.slice(0, HOMEPAGE_CHANGE_LIMIT)}
      sectors={sectors}
      movements={movements.slice(0, HOMEPAGE_MOVEMENT_LIMIT)}
      deltas={Object.fromEntries(deltaMap)}
      dataAsOf={DATA_AS_OF}
      coverage={coverage}
      generatedAt={new Date().toISOString()}
    />
  );
}
