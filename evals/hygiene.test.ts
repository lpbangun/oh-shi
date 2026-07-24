import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), "utf8");

test("starter artifacts and mojibake are absent", async () => {
  const files = [
    "app/layout.tsx",
    "app/components/JobBoard.tsx",
    "app/globals.css",
    "lib/seed.ts",
    "README.md",
    "package.json",
    "worker/index.ts",
  ];
  const forbidden = /vinext-starter|SkeletonPreview|react-loading-skeleton|â|Â|Ã/;
  for (const file of files) {
    assert.doesNotMatch(await read(file), forbidden, `${file} contains stale or corrupted copy`);
  }
  const previewDirectory = path.join(root, "app", "_sites-preview");
  const previewFiles = await readdir(previewDirectory).catch(() => []);
  assert.deepEqual(previewFiles, [], "starter preview directory must contain no artifacts");
});

test("social and legal assets are production-ready", async () => {
  const image = await readFile(path.join(root, "public", "og.png"));
  assert.equal(image.toString("hex", 0, 8), "89504e470d0a1a0a", "og.png must be a PNG");
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  assert.ok(width >= 1200 && height >= 600, `social card is too small: ${width}x${height}`);
  assert.ok(width / height > 1.8 && width / height < 2, "social card must be landscape");
  const layout = await read("app/layout.tsx");
  assert.ok(layout.includes("/og.png"));
  await Promise.all([
    access(path.join(root, "LICENSE")),
    access(path.join(root, "DATA-LICENSE.md")),
  ]);
});

test("Sites configuration is bound to the public project and D1", async () => {
  const hosting = JSON.parse(await read(".openai/hosting.json"));
  assert.match(hosting.project_id, /^appgprj_[a-f0-9]+$/);
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, null);
});

test("quality script enforces the intended gate order", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(
    pkg.scripts.quality,
    "pnpm run typecheck && pnpm run eval && pnpm run build"
  );
  assert.ok(pkg.scripts.eval);
  assert.ok(pkg.scripts["eval:live"]);
  assert.match(pkg.scripts.eval, /scripts\/run-evals\.mjs/);
  assert.match(pkg.scripts["eval:live"], /scripts\/run-evals\.mjs/);
});
