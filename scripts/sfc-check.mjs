import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const executable = require.resolve("vue-tsc/bin/vue-tsc.js");
const run = (config) =>
  new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [executable, "-p", config, "--noEmit", "--pretty", "false"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => done({ exitCode: code, output }));
  });

// 正例必须独立通过；反例必须逐项产生真实诊断，防止 *.vue 的 any shim 掩盖类型丢失。
const positive = await run("tests/sfc/tsconfig.json");
if (positive.exitCode !== 0) throw new Error(`Real SFC positive check failed:\n${positive.output}`);
const negative = await run("tests/sfc/tsconfig.negative.json");
const lines = (await readFile(resolve(root, "tests/sfc/negative.ts"), "utf8")).split("\n");
const cases = lines.flatMap((line, index) => {
  const name = /EXPECT_ERROR: (\S+)/.exec(line)?.[1];
  return name ? [{ name, startLine: index + 2, endLine: lines.length }] : [];
});
for (let index = 0; index < cases.length - 1; index++)
  cases[index].endLine = cases[index + 1].startLine - 2;
const diagnostics = negative.output.split("\n").flatMap((line) => {
  const match = /^(.*)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);
  return match
    ? [
        {
          file: match[1].replaceAll("\\", "/"),
          line: Number(match[2]),
          column: Number(match[3]),
          code: Number(match[4]),
          message: match[5],
        },
      ]
    : [];
});
for (const item of cases)
  item.diagnostics = diagnostics.filter(
    (d) =>
      d.file.endsWith("tests/sfc/negative.ts") &&
      d.line >= item.startLine &&
      d.line <= item.endLine,
  );
if (
  negative.exitCode === 0 ||
  cases.some((item) => item.diagnostics.length === 0) ||
  diagnostics.some((d) => !cases.some((item) => item.diagnostics.includes(d)))
) {
  throw new Error(
    `Real SFC negative checks must reject every case without unrelated errors:\n${negative.output}`,
  );
}
const report = {
  vueTsc: require("vue-tsc/package.json").version,
  node: process.version,
  positive,
  negative,
  cases,
  passed: true,
};
await mkdir(resolve(root, "reports"), { recursive: true });
await writeFile(
  resolve(root, "reports/sfc-type-results.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `Real Vue SFC inputs passed: positive project and ${cases.length} independently rejected negative cases (vue-tsc ${report.vueTsc}).`,
);
