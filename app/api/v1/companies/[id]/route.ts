import { apiEnvelope, getCompanyById, getJobsForCompany } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const company = await getCompanyById(id);
  if (!company) return Response.json({ error: "Company not found" }, { status: 404 });
  const jobs = await getJobsForCompany(id);
  return Response.json(apiEnvelope({ company, jobs }), {
    headers: { "Cache-Control": "public, max-age=300, s-maxage=900" },
  });
}
