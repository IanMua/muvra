import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

// 删除已移出框架的旧产物后再编译，打包不能夹带历史预设模块。
await rm("dist", { recursive: true, force: true });
const require = createRequire(import.meta.url);
const result = spawnSync(
  process.execPath,
  [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
