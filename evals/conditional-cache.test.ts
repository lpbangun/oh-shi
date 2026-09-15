import assert from "node:assert/strict";
import test from "node:test";
import {
  conditionalJsonResponse,
  requestMatchesEntityTag,
  weakEntityTag,
} from "../lib/conditional-cache";

test("conditional API responses expose a stable weak ETag and honor If-None-Match", async () => {
  const validator = JSON.stringify({ revision: "one", count: 3 });
  const first = await conditionalJsonResponse(
    new Request("https://example.test/api/v1/coverage"),
    { generated_at: "changes without changing the validator", data: { count: 3 } },
    { cacheControl: "public, max-age=60", validator }
  );
  const entityTag = first.headers.get("etag");
  assert.equal(first.status, 200);
  assert.ok(entityTag?.startsWith('W/"'));
  assert.equal(first.headers.get("access-control-allow-origin"), "*");

  const second = await conditionalJsonResponse(
    new Request("https://example.test/api/v1/coverage", {
      headers: { "If-None-Match": entityTag || "" },
    }),
    { generated_at: "later", data: { count: 3 } },
    { cacheControl: "public, max-age=60", validator }
  );
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "");
  assert.equal(second.headers.get("etag"), entityTag);
});

test("entity-tag matching accepts lists and weak comparison but rejects changed data", async () => {
  const tag = await weakEntityTag("same semantic representation");
  assert.equal(requestMatchesEntityTag(new Request("https://example.test", {
    headers: { "If-None-Match": `\"other\", ${tag.replace("W/", "")}` },
  }), tag), true);
  assert.notEqual(tag, await weakEntityTag("different semantic representation"));
});
