import { listChanges, listCompanies, listJobs } from "@/lib/data";
import { JobBoard } from "./components/JobBoard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [companies, jobs, changes] = await Promise.all([
    listCompanies(),
    listJobs(),
    listChanges(),
  ]);

  return <JobBoard companies={companies} jobs={jobs} changes={changes} />;
}
