import { expect, test } from "@playwright/test";

for (const [term, title] of [
  ["nurse", "Nurse Practitioner"],
  ["driver", "Delivery Driver"],
  ["accountant", "Staff Accountant"],
] as const) {
  test(`q=${term} finds the non-tech fixture via title without role-family routing`, async ({ request }) => {
    const response = await request.get(`/api/v1/jobs?q=${term}`);
    expect(response.status()).toBe(200);
    const payload = await response.json();
    expect(payload.data.some((job: { title: string }) => job.title === title)).toBe(true);
    expect(payload.applied_filters.roleFamily).toBeNull();
    const intelligence = await (await request.get(`/api/v1/intelligence?view=jobs&q=${term}`)).json();
    expect(intelligence.data.some((job: { title: string }) => job.title === title)).toBe(true);
    expect(intelligence.applied_filters.role_family).toBeNull();
  });
}
