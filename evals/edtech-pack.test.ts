import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertValidEdtechPack,
  containsDisallowedHost,
  DISALLOWED_PACK_HOSTS,
  isKnownAtsApiHost,
  loadEdtechPack,
  validateEdtechPack,
} from "../lib/edtech-pack";

const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), "utf8");

const WELL_KNOWN_BOARD_IDS = [
  "coursera",
  "duolingo",
  "khanacademy",
  "instructure",
  "quizlet-2",
  "classdojo",
  "udemy",
  "masterclass",
  "newsela",
  "outschool",
  "amplify",
  "degreed",
  "datacamp",
  "brilliant",
  "aofl",
  "handshake",
  "babbel",
  "clever",
  "seesaw",
  "edpuzzle",
  "skillsoft",
  "gostudent",
  "givecampus",
  "teachablecareers",
  "learnupon",
  "magicschool",
  "brisk-teaching",
  "prairielearn",
  "follettsoftware",
  "schoolstatus",
  "teachstone",
  "2u",
  "docebo",
  "guild",
  "renaissancelearning-nam",
] as const;

test("edtech pack parses with required fields on every row", async () => {
  const pack = await loadEdtechPack();
  assert.equal(pack.schemaVersion, "1.0");
  assert.equal(pack.vertical, "edtech");
  assert.ok(pack.rows.length >= 50, `expected a serious reviewed set, received ${pack.rows.length}`);
  for (const row of pack.rows) {
    assert.ok(row.name, "name is required");
    assert.ok(row.website, "website is required");
    assert.ok(row.provider, "provider is required");
    assert.ok(row.board_id, "board_id is required");
    assert.ok(row.evidence_url, "evidence_url is required");
    assert.equal(row.vertical, "edtech");
  }
  assertValidEdtechPack(pack);
});

test("edtech pack rows are unique by provider and board_id", async () => {
  const pack = await loadEdtechPack();
  const keys = pack.rows.map((row) => `${row.provider}:${row.board_id.toLowerCase()}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("edtech pack website and evidence_url are HTTPS with known ATS API hosts", async () => {
  const pack = await loadEdtechPack();
  for (const row of pack.rows) {
    assert.match(row.website, /^https:\/\//);
    assert.match(row.evidence_url, /^https:\/\//);
    const host = new URL(row.evidence_url).hostname.toLowerCase();
    assert.ok(isKnownAtsApiHost(host), `unexpected evidence host: ${host}`);
  }
});

test("edtech pack includes must-have and well-known education boards when present", async () => {
  const pack = await loadEdtechPack();
  const boardIds = new Set(pack.rows.map((row) => row.board_id.toLowerCase()));
  assert.ok(boardIds.has("coursera"), "pack must include Coursera when legally confirmable");
  assert.ok(boardIds.has("duolingo"), "pack must include Duolingo when legally confirmable");
  const presentWellKnown = WELL_KNOWN_BOARD_IDS.filter((boardId) => boardIds.has(boardId));
  assert.ok(
    presentWellKnown.length >= 20,
    `expected many well-known education boards, found ${presentWellKnown.length}`
  );
});

test("gate 1 code and pack files avoid disallowed scrape hosts", async () => {
  const packJson = await loadEdtechPack();
  for (const row of packJson.rows) {
    assert.equal(containsDisallowedHost(row.website), false);
    assert.equal(containsDisallowedHost(row.evidence_url), false);
  }
  const builder = await read("scripts/build-edtech-pack.ts");
  for (const host of DISALLOWED_PACK_HOSTS) {
    assert.doesNotMatch(
      builder,
      new RegExp(`https?://[^\\s"']*${host.replace(/\./g, "\\.")}`, "i"),
      `builder must not fetch disallowed host ${host}`
    );
  }
});

test("edtech pack validation reports structural issues", () => {
  const issues = validateEdtechPack({
    schemaVersion: "1.0",
    vertical: "edtech",
    generatedAt: "2026-09-20T00:00:00.000Z",
    reviewRule: "test",
    attribution: {
      lastround: "test",
      lastroundLicense: "CC BY 4.0",
      lastroundUrl: "https://example.com",
    },
    rows: [{
      name: "Dup",
      website: "https://example.com/",
      provider: "greenhouse",
      board_id: "dup",
      evidence_url: "https://boards-api.greenhouse.io/v1/boards/dup/jobs?content=true",
      vertical: "edtech",
    }, {
      name: "Dup 2",
      website: "https://example.org/",
      provider: "greenhouse",
      board_id: "dup",
      evidence_url: "https://boards-api.greenhouse.io/v1/boards/dup/jobs?content=true",
      vertical: "edtech",
    }],
  });
  assert.ok(issues.some((issue) => issue.code === "duplicate_board"));
});

test("third_party lastround attribution is vendored for offline builds", async () => {
  const readme = await read("third_party/lastround/README.md");
  const csv = await read("third_party/lastround/lastroundai-ats-company-directory-2026-08.csv");
  assert.match(readme, /CC BY 4\.0/i);
  assert.match(readme, /lastroundai-hiring-data/i);
  assert.match(csv, /^ats_vendor,company_name,board_slug,last_crawled/);
  const files = await readdir("third_party/lastround");
  assert.ok(files.includes("lastroundai-ats-company-directory-2026-08.csv"));
});
