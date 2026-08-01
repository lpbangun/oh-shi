import { expect, test } from "@playwright/test";

type IntelligencePayload<T> = {
  schema_version: string;
  data_as_of: string;
  view: string;
  applied_filters: Record<string, unknown>;
  page: {
    limit: number;
    returned: number;
    next_cursor: string | null;
    total: number;
  };
  data: T[];
};

test.describe("unified agent contract", () => {
  test("default job APIs share the company-diverse order", async ({ request }) => {
    const compatibilityResponse = await request.get("/api/v1/jobs");
    expect(compatibilityResponse.status()).toBe(200);
    const compatibility = (await compatibilityResponse.json()) as {
      data: Array<{ id: string; companyId: string }>;
    };
    const intelligenceResponse = await request.get(
      "/api/v1/intelligence?view=jobs&limit=8"
    );
    expect(intelligenceResponse.status()).toBe(200);
    const intelligence =
      (await intelligenceResponse.json()) as IntelligencePayload<{
        id: string;
        companyId: string;
      }>;

    expect(compatibility.data.slice(0, 8).map((job) => job.id)).toEqual(
      intelligence.data.map((job) => job.id)
    );
    expect(
      new Set(compatibility.data.slice(0, 4).map((job) => job.companyId)).size
    ).toBe(4);
  });

  test("capabilities and llms.txt expose one deterministic entrypoint", async ({
    request,
  }) => {
    const capabilities = await request.get("/api/v1/intelligence");
    expect(capabilities.status()).toBe(200);
    const payload = await capabilities.json();
    expect(payload.data.preferred_entrypoint).toBe("/api/v1/intelligence");
    expect(Object.keys(payload.data.views).sort()).toEqual([
      "companies",
      "jobs",
      "movements",
      "sectors",
    ]);

    const instructions = await request.get("/llms.txt");
    expect(await instructions.text()).toContain(
      "/api/v1/intelligence?view=movements"
    );
  });

  test("company pagination is capped, gap-free, and receipts reconcile", async ({
    request,
  }) => {
    const firstResponse = await request.get(
      "/api/v1/intelligence?view=companies"
    );
    expect(firstResponse.status()).toBe(200);
    const first =
      (await firstResponse.json()) as IntelligencePayload<{
        id: string;
        hiringScore: number;
        evidenceConfidence: number;
        signal: {
          value: number;
          components: Array<{ points: number; max: number }>;
        };
        confidence: {
          value: number;
          components: Array<{ points: number; max: number }>;
        };
      }>;
    expect(first.page.limit).toBe(10);
    expect(first.data).toHaveLength(10);
    expect(first.page.next_cursor).not.toBeNull();

    for (const company of first.data) {
      expect(company.signal.value).toBe(company.hiringScore);
      expect(company.confidence.value).toBe(company.evidenceConfidence);
      for (const receipt of [company.signal, company.confidence]) {
        expect(
          Math.round(
            receipt.components.reduce(
              (sum, component) => sum + component.points,
              0
            ) * 100
          ) / 100
        ).toBe(receipt.value);
        expect(
          receipt.components.every(
            (component) =>
              component.points >= 0 && component.points <= component.max
          )
        ).toBe(true);
      }
    }

    const secondResponse = await request.get(
      `/api/v1/intelligence?view=companies&cursor=${encodeURIComponent(
        first.page.next_cursor as string
      )}`
    );
    const second =
      (await secondResponse.json()) as IntelligencePayload<{ id: string }>;
    expect(second.data.length).toBeGreaterThan(0);
    expect(second.data.length).toBeLessThanOrEqual(10);
    const firstIds = new Set(first.data.map((company) => company.id));
    expect(second.data.some((company) => firstIds.has(company.id))).toBe(false);
  });

  test("documented filters apply and invalid filters fail closed", async ({
    request,
  }) => {
    const jobsResponse = await request.get(
      "/api/v1/intelligence?view=jobs&role_family=Operations&remote_status=Remote"
    );
    const jobs =
      (await jobsResponse.json()) as IntelligencePayload<{
        roleFamily: string;
        remoteStatus: string;
      }>;
    expect(jobsResponse.status()).toBe(200);
    expect(jobs.data.length).toBeGreaterThan(0);
    expect(
      jobs.data.every(
        (job) =>
          job.roleFamily.includes("Operations") &&
          job.remoteStatus.includes("Remote")
      )
    ).toBe(true);

    const healthcareResponse = await request.get(
      "/api/v1/intelligence?view=companies&sector=Healthcare&min_confidence=80"
    );
    const healthcare =
      (await healthcareResponse.json()) as IntelligencePayload<{
        sector: string;
        evidenceConfidence: number;
      }>;
    expect(healthcareResponse.status()).toBe(200);
    expect(healthcare.data.length).toBeGreaterThan(0);
    expect(
      healthcare.data.every(
        (company) =>
          company.sector === "Healthcare" &&
          company.evidenceConfidence >= 80
      )
    ).toBe(true);

    const invalid = await request.get(
      "/api/v1/intelligence?view=jobs&industry=AI"
    );
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).error).toBe("invalid_request");
  });

  test("market movements expose aggregates and standalone funding evidence", async ({
    request,
  }) => {
    const companyResponse = await request.get(
      "/api/v1/intelligence?view=movements&company=cognition"
    );
    const companyMovements =
      (await companyResponse.json()) as IntelligencePayload<{
        id: string;
        companySlug: string | null;
        evidenceCount: number;
        jobs: Array<{ id: string; canonicalUrl: string; sourceUrl: string }>;
      }>;
    expect(companyMovements.data.length).toBeGreaterThan(0);
    expect(
      companyMovements.data.every(
        (movement) =>
          movement.companySlug === "cognition" &&
          movement.evidenceCount === movement.jobs.length &&
          movement.jobs.every(
            (job) => job.id && job.canonicalUrl && job.sourceUrl
          )
      )
    ).toBe(true);

    const fundingResponse = await request.get(
      "/api/v1/intelligence?view=movements&type=funding&limit=10"
    );
    const funding =
      (await fundingResponse.json()) as IntelligencePayload<{
        type: string;
        sourceUrls: string[];
      }>;
    expect(funding.data.length).toBeGreaterThan(0);
    expect(
      funding.data.every(
        (movement) =>
          movement.type === "funding" && movement.sourceUrls.length > 0
      )
    ).toBe(true);
  });

  test("coverage totals reconcile with compatibility records", async ({ request }) => {
    const [coverageResponse, jobsResponse, signalsResponse, offBoardResponse] = await Promise.all([
      request.get("/api/v1/coverage"),
      request.get("/api/v1/jobs"),
      request.get("/api/v1/signals"),
      request.get("/api/v1/off-board-openings"),
    ]);
    expect(coverageResponse.status()).toBe(200);
    expect(jobsResponse.status()).toBe(200);
    expect(signalsResponse.status()).toBe(200);
    expect(offBoardResponse.status()).toBe(200);
    const coverage = await coverageResponse.json();
    const jobs = await jobsResponse.json();
    const signalPayload = await signalsResponse.json();
    const offBoardPayload = await offBoardResponse.json();
    const openJobs = jobs.data.filter(
      (job: { status: string }) => job.status === "verified_open"
    );
    expect(
      openJobs.every(
        (job: { provider?: string; sourceId?: string }) =>
          Boolean(job.provider) && Boolean(job.sourceId) && job.sourceId !== "legacy"
      )
    ).toBe(true);
    expect(coverage.data.verifiedOpenJobs).toBe(openJobs.length);
    expect(coverage.data.activeCompanies).toBe(
      new Set(openJobs.map((job: { companyId: string }) => job.companyId)).size
    );
    expect(coverage.data.investors).toBeTruthy();
    expect(coverage.data.providers).toBeTruthy();
    expect(signalPayload.data.classification).toBe(
      "hiring_signal_not_verified_opening"
    );
    expect(coverage.data.activeHiringSignals).toBe(
      signalPayload.data.signals.length
    );
    expect(offBoardPayload.data.classification).toBe(
      "off_board_verified_opening"
    );
    expect(coverage.data.offBoardVerifiedOpenings).toBe(
      offBoardPayload.data.openings.length
    );
    expect(coverage.data.offBoardVerifiedCompanies).toBe(
      new Set(
        offBoardPayload.data.openings.map(
          (opening: { companyId: string }) => opening.companyId
        )
      ).size
    );
    expect(
      signalPayload.data.signals.every(
        (signal: { status: string; expiresAt: string }) =>
          signal.status === "active" &&
          Date.parse(signal.expiresAt) > Date.parse(signalPayload.generated_at)
      )
    ).toBe(true);
  });
});
