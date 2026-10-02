import { readFile, writeFile } from "node:fs/promises";
import { stageCohortRows } from "../lib/cohort-staging";

// Local, opt-in validation only. It never contacts a site or a database.
const [input, output] = process.argv.slice(2);
if (!input || !output || input === output) {
  throw new Error("Usage: tsx scripts/stage-cohort-manifest.ts INPUT.jsonl OUTPUT.json");
}
const lines = (await readFile(input, "utf8")).split(/\r?\n/).filter((line) => line.trim());
const rows = lines.map((line, index) => {
  try { return JSON.parse(line) as unknown; }
  catch { return { invalid_json_line: index + 1 }; }
});
const result = stageCohortRows(rows, new Date().toISOString());
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ staged: result.staged.length,
  runnable: result.staged.filter((row) => row.runnable).length,
  issues: result.issues.length, output })}\n`);
