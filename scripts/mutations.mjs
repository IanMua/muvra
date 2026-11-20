import { cp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { hashInputs } from "./hash-inputs.mjs";
const root = resolve(import.meta.dirname, "..");
const runId = String(Date.now());
const destination = resolve(root, "reports/mutations", runId);
await mkdir(destination, { recursive: true });

// 在独立拷贝中故意破坏契约；编译失败不计为检出，只有可执行变体被断言击中才算有效。
const operators = [
  [
    "backdrop-foreground",
    "extensions/backdrop.ts",
    "const foreground = visible.at(-1);",
    "const foreground = visible.at(-2);",
  ],
  [
    "extension-default-merge",
    "layers/extensions.ts",
    "definition.mergeOptions?.(previous.options, definition.options)",
    "definition.mergeOptions?.({}, definition.options)",
  ],
  [
    "layer-owner-cleanup",
    "layers/stack.ts",
    "if (child.owner === record.anchor) disposeRecord(child);",
    "if (false && child.owner === record.anchor) disposeRecord(child);",
  ],
  [
    "layer-cycle-validation",
    "layers/order.ts",
    "if (result.length !== all.length)",
    "if (false && result.length !== all.length)",
  ],
  [
    "disposed-renderer-resource",
    "engine.ts",
    "dynamicDefinitions.clear();\n      renderer = undefined;\n      rendererDuration = undefined;",
    "dynamicDefinitions.clear();\n      renderer = undefined;",
  ],
  [
    "effect-own-cleanup",
    "animation/scope.ts",
    "own(() => animation.cancel());",
    "own(() => { /* 实验变体：不释放转场句柄。 */ });",
  ],
  [
    "exit-effect-owner",
    "animation/effect.ts",
    "? (from ?? to ?? fallback)",
    "? (to ?? from ?? fallback)",
  ],
  [
    "sync-unsubscribe",
    "async.ts",
    "if (done) cleanupSubscription();",
    "if (done) { /* 实验变体：保留订阅。 */ }",
  ],
  [
    "tab-root-default",
    "engine.ts",
    "keepTabRoot: input.keepTabRoot ?? true",
    "keepTabRoot: input.keepTabRoot ?? false",
  ],
  ["duplicate-key", "planner.ts", "if (identities.has(identity))", "if (false)"],
  ["global-guards", "engine.ts", "const chain = [...guards];", "const chain: RuntimeGuard[] = [];"],
  [
    "reset-prefix",
    "planner.ts",
    "next.entering = [...next.history];",
    "next.entering = next.history.slice(-1);",
  ],
  ["shared-props", "vue.ts", "...shared,", "...(false ? shared : {}),"],
  [
    "cache-retention",
    "record-store.ts",
    'const keep = record.definition.cache ?? record.route.kind === "tab";',
    'const keep = false && (record.definition.cache ?? record.route.kind === "tab");',
  ],
  ["timeouts", "async.ts", "if (options.timeoutMs > 0)", "if (options.timeoutMs < 0)"],
  [
    "transition-result",
    "engine.ts",
    'return ran ? "completed" : "skipped";',
    'return ran ? "skipped" : "skipped";',
  ],
  [
    "readonly-history",
    "engine.ts",
    "history: Object.freeze([...history]),",
    "history: [...history],",
  ],
  [
    "resume-intent",
    "engine.ts",
    "intent = interception.intent;",
    'intent = { ...interception.intent, operation: "push" };',
  ],
  ["view-unload", "vue.ts", 'kind === "unload" ||', "false ||"],
  ["dynamic-gc", "engine.ts", "dynamicDefinitions.delete(name)", "dynamicDefinitions.has(name)"],
  [
    "lazy-abort",
    "lazy.ts",
    `const module = await settle(() => loader(abort.signal), {
            signal: abort.signal,
            timeoutMs: 0,
            empty: undefined,
          });`,
    "void settle; const module = await loader(abort.signal);",
  ],
];
const run = (args, cwd) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }, 20_000);
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code, timedOut, output });
    });
  });
const report = { inputsSha256: await hashInputs(root), mutants: [] };
async function prepare(directory) {
  await mkdir(directory, { recursive: true });
  await cp(resolve(root, "src"), resolve(directory, "src"), { recursive: true });
  await cp(resolve(root, "tsconfig.json"), resolve(directory, "tsconfig.json"));
  await writeFile(
    resolve(directory, "package.json"),
    JSON.stringify({
      name: "muvra",
      type: "module",
      exports: {
        ".": { import: "./dist/index.js" },
        "./extensions/backdrop": { import: "./dist/extensions/backdrop.js" },
      },
    }),
  );
  await mkdir(resolve(directory, "tests"), { recursive: true });
  for (const file of await readdir(resolve(root, "tests")))
    if (file.endsWith(".mjs"))
      await cp(resolve(root, "tests", file), resolve(directory, "tests", file));
  await cp(resolve(root, "tests/sfc"), resolve(directory, "tests/sfc"), { recursive: true });
  await cp(resolve(root, "demo/transitions"), resolve(directory, "demo/transitions"), {
    recursive: true,
  });
  await mkdir(resolve(directory, "scripts"), { recursive: true });
  await cp(resolve(root, "scripts/sfc-plugin.mjs"), resolve(directory, "scripts/sfc-plugin.mjs"));
}
const testArguments = [
  "--test",
  ...(await readdir(resolve(root, "tests")))
    .filter((file) => file.endsWith(".test.mjs"))
    .map((file) => `tests/${file}`),
];
const control = resolve(destination, "control");
await prepare(control);
const controlBuild = await run(
  [resolve(root, "node_modules/typescript/lib/tsc.js"), "-p", "tsconfig.json"],
  control,
);
const controlTests = controlBuild.exitCode === 0 ? await run(testArguments, control) : undefined;
await writeFile(resolve(control, "result.log"), controlBuild.output + (controlTests?.output ?? ""));
if (controlBuild.exitCode !== 0 || controlTests.exitCode !== 0)
  throw new Error("Unmodified mutation control must pass before evaluating any mutant.");
report.control = { buildExitCode: controlBuild.exitCode, testExitCode: controlTests.exitCode };
for (const [name, filename, before, after] of operators) {
  const directory = resolve(destination, name);
  await prepare(directory);
  const file = resolve(directory, "src", filename);
  const source = await readFile(file, "utf8");
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before))
    throw new Error(`Mutation ${name} anchor must occur exactly once.`);
  await writeFile(file, source.replace(before, after));
  const build = await run(
    [resolve(root, "node_modules/typescript/lib/tsc.js"), "-p", "tsconfig.json"],
    directory,
  );
  const tests =
    build.exitCode === 0
      ? await run(
          [
            "--test",
            ...(await readdir(resolve(directory, "tests")))
              .filter((file) => file.endsWith(".test.mjs"))
              .map((file) => `tests/${file}`),
          ],
          directory,
        )
      : undefined;
  const status = build.exitCode !== 0 ? "unviable" : tests.exitCode === 0 ? "survived" : "detected";
  await writeFile(resolve(directory, "result.log"), build.output + (tests?.output ?? ""));
  report.mutants.push({
    name,
    status,
    buildExitCode: build.exitCode,
    testExitCode: tests?.exitCode,
    timedOut: tests?.timedOut,
    log: `reports/mutations/${runId}/${name}/result.log`,
  });
  await writeFile(
    resolve(root, "reports/mutation-results.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`${name}: ${status}`);
}
report.finalInputsSha256 = await hashInputs(root);
report.valid = report.inputsSha256 === report.finalInputsSha256;
await writeFile(
  resolve(root, "reports/mutation-results.json"),
  JSON.stringify(report, null, 2) + "\n",
);
if (!report.valid || report.mutants.some((mutant) => mutant.status !== "detected"))
  process.exitCode = 1;
