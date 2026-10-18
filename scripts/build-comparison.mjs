import { tsImport } from "tsx/esm/api";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
const { buildComparison, comparisonHtml } = await tsImport("../lib/daily-engine/report.ts", import.meta.url);
const args = process.argv.slice(2);
const get = (key, fallback) => args.includes(key) ? args[args.indexOf(key)+1] : fallback;
const out = resolve(get("--out","outputs/comparison"));
const baseline = JSON.parse(await readFile(get("--baseline","fixtures/daily-engine/baseline.json"),"utf8"));
const inputs = await Promise.all([get("--direct","outputs/lane-a"),get("--tinyfish","outputs/lane-b")].map(async path => ({
  report: JSON.parse(await readFile(path+"/run-report.json","utf8")),
  records: JSON.parse(await readFile(path+"/records.json","utf8")),
  path: relative(out,resolve(path)),
})));
const blockedDir = get("--blocked","outputs/tinyfish-blocked");
let blocked;
try {
  blocked = { report: JSON.parse(await readFile(blockedDir+"/run-report.json","utf8")), path: relative(out,resolve(blockedDir)) };
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const data = buildComparison(inputs,baseline,blocked);
await mkdir(out,{recursive:true});
await writeFile(out+"/comparison.json",JSON.stringify(data,null,2)+"\n");
await writeFile(out+"/comparison.html",comparisonHtml(data));
console.log(JSON.stringify({verdict:data.verdict,html:out+"/comparison.html",json:out+"/comparison.json"}));
