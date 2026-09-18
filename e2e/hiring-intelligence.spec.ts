import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const isMobile = (projectName: string) => projectName.startsWith("mobile");

async function openHome(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open jobs" })).toBeVisible();
  // The heading is server-rendered. The live countdown only gains an HH:MM:SS
  // value after React hydration, so it is a deterministic interaction-ready hook.
  await expect(page.locator(".ticker-next")).toHaveText(/NEXT RUN \d{2}:\d{2}:\d{2}/);
}

async function expectNoSeriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .include("main")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter(({ impact }) =>
    impact === "serious" || impact === "critical"
  );
  const summary = blocking.map(({ id, impact, nodes }) => ({
    id,
    impact,
    targets: nodes.map((node) => node.target),
  }));
  expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
}

function numericRange(status: string) {
  const match = status.match(/Showing\s+(\d+)[–-](\d+)\s+of\s+(\d+)/i);
  expect(match, `Expected a pagination range in "${status}"`).not.toBeNull();
  return {
    start: Number(match?.[1]),
    end: Number(match?.[2]),
    total: Number(match?.[3]),
  };
}

test("the repository link is visible and keyboard accessible", async ({ page }) => {
  await openHome(page);
  const repositoryLink = page.getByRole("link", { name: "OH SHI on GitHub" });
  await expect(repositoryLink).toBeVisible();
  await expect(repositoryLink).toHaveAttribute("href", "https://github.com/lpbangun/oh-shi");
  await expect(repositoryLink).toHaveAttribute("target", "_blank");
  await repositoryLink.focus();
  await expect(repositoryLink).toBeFocused();
});

test.describe("desktop hiring intelligence", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), "Desktop-specific interaction");
    await openHome(page);
  });

  test("location menu scrolls internally without closing", async ({ page }) => {
    const trigger = page.getByRole("button", { name: /^Location\b/i });
    await trigger.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();

    const scroll = await menu.evaluate((element) => {
      const before = element.scrollTop;
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
      return {
        before,
        after: element.scrollTop,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      };
    });
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    expect(scroll.after).toBeGreaterThan(scroll.before);
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    await page.evaluate(() => window.scrollBy({ top: 120, behavior: "instant" }));
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("live ticker moves slowly and can be paused", async ({ page }) => {
    const ticker = page.getByRole("region", { name: "Live hiring activity" });
    const duration = await ticker.locator(".ticker-track").evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).animationDuration)
    );
    expect(duration).toBeGreaterThanOrEqual(180);

    const toggle = ticker.locator(".ticker-toggle");
    await expect(toggle).toHaveAccessibleName("Pause live ticker");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toHaveAccessibleName("Resume live ticker");
  });

  test("filter menu Escape closes and restores focus", async ({ page }) => {
    const trigger = page.getByRole("button", { name: /^Location\b/i });
    await trigger.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("market content follows the required order", async ({ page }) => {
    const signal = page.locator("#signal");
    const movements = signal.getByTestId("market-movements");
    const sectorMap = signal.locator(".sector-map");
    const companies =
      signal.getByTestId("companies-list").or(signal.locator(".table-wrap")).first();
    const changes =
      signal.getByTestId("changes-list").or(signal.locator("#changes")).first();

    await expect(movements).toBeVisible();
    await expect(sectorMap).toBeVisible();
    await expect(companies).toBeVisible();
    await expect(changes).toBeVisible();

    const boxes = await Promise.all(
      [movements, sectorMap, companies, changes].map((locator) => locator.boundingBox())
    );
    const ordered = boxes.map((box) => {
      expect(box).not.toBeNull();
      return box?.y ?? -1;
    });
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
  });

  test("a market movement is keyboard-clickable and opens its destination", async ({ page }) => {
    const movement = page.getByTestId("market-movement").first();
    const initialUrl = page.url();
    await expect(movement).toBeVisible();
    await movement.focus();
    await expect(movement).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const dialogVisible = await page.getByRole("dialog").first().isVisible().catch(() => false);
      const filterVisible = await page.locator("#jobs .clear-filters").isVisible().catch(() => false);
      const sectorVisible = await page
        .locator(".sector-tile[aria-pressed='true']")
        .isVisible()
        .catch(() => false);
      return dialogVisible || filterVisible || sectorVisible || page.url() !== initialUrl;
    }).toBe(true);
  });

  test("funding movements expose a navigable citation and calibrated signal", async ({ page }) => {
    const funding = page.locator(".market-movement.funding").first();
    await expect(funding).toBeVisible();
    await expect(funding.locator(".movement-kind")).toHaveText("Funding");
    await expect(funding.locator(".movement-signal small")).toHaveText("hiring signal");
    await expect(funding.locator(".movement-source")).toHaveAttribute("href", /^https:\/\//);
    await expect(funding.locator(".movement-source")).toHaveAttribute("target", "_blank");
  });

  test("job search matches the API and survives reload and Back", async ({ page, request }) => {
    const search = page.getByLabel("Search jobs");
    await search.fill("engineer");
    await expect(page).toHaveURL(/q=engineer/);
    await expect(page.locator("#jobs .job-index-status")).not.toContainText("loading");
    const browserIds = await page.locator("#jobs [data-job-id]").evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-job-id"))
    );
    const apiResponse = await request.get("/api/v1/intelligence?view=jobs&q=engineer&limit=50");
    expect(apiResponse.status()).toBe(200);
    const api = await apiResponse.json();
    expect(browserIds).toEqual(api.data.map((job: { id: string }) => job.id));
    await expect(page.locator("#jobs .pager-status")).toContainText(`of ${api.page.total}`);
    await expect(page.locator("#jobs .posting-link").first()).toHaveAttribute("href", /^https:\/\//);

    await page.reload();
    await expect(search).toHaveValue("engineer");
    await search.fill("designer");
    await expect(page).toHaveURL(/q=designer/);
    await page.goBack();
    await expect(search).toHaveValue("engineer");
  });

  test("natural-language job search shows its interpretation", async ({ page }) => {
    const search = page.getByLabel("Search jobs");
    await search.fill("full-time engineering jobs in San Francisco");
    await expect(page).toHaveURL(/q=full-time\+engineering\+jobs\+in\+San\+Francisco/);
    await expect(page.getByText("Searching Engineering · Full time · near San Francisco")).toBeVisible();
    await expect(page.getByRole("button", {
      name: "Full Stack Engineer at Hotplate, verified open",
    })).toBeVisible();
    await expect(page.locator("#jobs .pager-status")).toContainText("of 1");
  });

  test("companies paginate ten at a time without duplicates", async ({ page }) => {
    const signal = page.locator("#signal");
    const pager = signal.locator(".pager").filter({ hasText: /companies/i });
    const status = pager.locator(".pager-status");
    const firstRange = numericRange(await status.innerText());
    expect(firstRange.start).toBe(1);
    expect(firstRange.end - firstRange.start + 1).toBe(
      Math.min(10, firstRange.total)
    );

    const rows = signal.locator(".table-wrap tbody tr");
    await expect(rows).toHaveCount(Math.min(10, firstRange.total));
    const firstPageNames = await rows.locator("td:first-child").allInnerTexts();

    if (firstRange.total > 10) {
      await pager.getByRole("button", { name: /Next/i }).click();
      await expect(status).toContainText(/Showing 11[–-]/);
      const secondRange = numericRange(await status.innerText());
      expect(secondRange.start).toBe(11);
      const secondPageNames = await rows.locator("td:first-child").allInnerTexts();
      expect(secondPageNames.filter((name) => firstPageNames.includes(name))).toEqual([]);
    }
  });

  test("raw changes paginate twenty-five at a time", async ({ page }) => {
    const changes = page.getByTestId("changes-list");
    const pager = changes.locator(".pager");
    const status = pager.locator(".pager-status");
    const firstRange = numericRange(await status.innerText());
    const items = page.getByTestId("change-item");

    expect(firstRange.start).toBe(1);
    await expect(items).toHaveCount(Math.min(25, firstRange.total));
    await expect(changes.getByText("Company unavailable", { exact: true })).toHaveCount(0);
    if (firstRange.total > 25) {
      await pager.getByRole("button", { name: /Next/i }).click();
      expect(numericRange(await status.innerText()).start).toBe(26);
    }
  });

  test("signal and confidence explainers publish calculation receipts", async ({ page }) => {
    const signalButton = page
      .locator('summary[aria-label="Hiring signal explainer"]')
      .first();
    await signalButton.click();
    const signalReceipt = signalButton.locator("xpath=..").locator(".info-popover");
    await expect(signalReceipt).toContainText(/open-role volume/i);
    await expect(signalReceipt).toContainText(/growth/i);
    await expect(signalReceipt).toContainText(/funding/i);
    await expect(signalReceipt).toContainText(/freshness/i);
    await page.keyboard.press("Escape");

    const confidenceButton = page
      .locator('summary[aria-label="Confidence explainer"]')
      .first();
    await confidenceButton.click();
    const confidenceReceipt = confidenceButton.locator("xpath=..").locator(".info-popover");
    await expect(confidenceReceipt).toContainText(/verification recency/i);
    await expect(confidenceReceipt).toContainText(/verified/i);
    await expect(confidenceReceipt).toContainText(/completeness/i);
    await expect(confidenceReceipt).toContainText(/source|corroboration/i);
  });

  test("empty off-board evidence is omitted from the homepage", async ({ page }) => {
    const verifiedJobs = page.locator("#jobs");
    const offRadar = page.locator("#off-the-radar");
    await expect(verifiedJobs.getByRole("heading", { name: "Open jobs" })).toBeVisible();
    await expect(offRadar).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Off the radar" })).toHaveCount(0);
  });

  test("desktop has no serious accessibility violations", async ({ page }) => {
    await expectNoSeriousAxeViolations(page);
  });
});

test.describe("mobile hiring intelligence", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!isMobile(testInfo.project.name), "Mobile-specific interaction");
    await openHome(page);
  });

  test("fits the viewport and keeps capped company pagination usable", async ({ page }) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);

    const signal = page.locator("#signal");
    const pager = signal.locator(".pager").filter({ hasText: /companies/i });
    const range = numericRange(await pager.locator(".pager-status").innerText());
    await expect(signal.locator(".company-list .company-row")).toHaveCount(
      Math.min(10, range.total)
    );
    await expect(pager.getByRole("button", { name: /Next/i })).toBeVisible();
  });

  test("supports reduced motion and has no serious accessibility violations", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const animation = await page.locator(".ticker-track").evaluate(
      (element) => getComputedStyle(element).animationName
    );
    expect(animation).toBe("none");
    await expectNoSeriousAxeViolations(page);
  });
});
