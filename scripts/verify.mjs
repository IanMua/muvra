import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { hashInputs } from "./hash-inputs.mjs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
await mkdir(resolve(root, "reports/gates"), { recursive: true });
const steps = [
  ["build", ["run", "build"]],
  ["types", ["run", "typecheck"]],
  ["sfc-types", ["run", "typecheck:sfc"]],
  ["node", ["test"]],
  ["format", ["run", "format:check"]],
  ["mutations", ["run", "test:mutations"]],
  ["package", ["run", "check:package"]],
  ["consumer", ["run", "test:consumer"]],
  ["browser", ["run", "test:browser"]],
];
const report = {
  inputsSha256: await hashInputs(root),
  startedAt: new Date().toISOString(),
  node: process.version,
  gates: [],
  complete: false,
};
const save = () =>
  writeFile(resolve(root, "reports/verification.json"), JSON.stringify(report, null, 2) + "\n");
for (const [name, args] of steps) {
  const logfile = `reports/gates/${name}.log`;
  const stream = createWriteStream(resolve(root, logfile));
  console.log(`Running ${name}: pnpm ${args.join(" ")}`);
  const started = Date.now();
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn("pnpm", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.on("error", reject);
    child.on("close", resolveExit);
  });
  await new Promise((done) => stream.end(done));
  report.gates.push({
    name,
    command: `pnpm ${args.join(" ")}`,
    exitCode,
    elapsedMs: Date.now() - started,
    log: logfile,
  });
  await save();
  if (exitCode !== 0) {
    console.error(`${name} failed; inspect ${logfile}`);
    process.exitCode = 1;
    break;
  }
}
report.finalInputsSha256 = await hashInputs(root);
report.complete =
  report.gates.length === steps.length &&
  report.gates.every((gate) => gate.exitCode === 0) &&
  report.inputsSha256 === report.finalInputsSha256;
report.finishedAt = new Date().toISOString();
await save();
// 输入变动也必须让自动化调用失败，防止仅凭关卡退出码接受混合版本证据。
if (!report.complete) process.exitCode = 1;
console.log(
  report.complete
    ? "All recorded gates passed. Requirement-by-requirement maturity audit is still separate."
    : "Verification incomplete.",
);
