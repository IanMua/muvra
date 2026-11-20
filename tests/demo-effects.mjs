import { build } from "esbuild";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 特效由业务演示持有；验证时独立编译，防止框架导出再次混入视觉预设。
await mkdir(resolve("reports/demo"), { recursive: true });
const directory = await mkdtemp(resolve("reports/demo/transitions-"));
await build({
  entryPoints: { effects: "demo/transitions/effects.ts", waapi: "demo/transitions/waapi.ts" },
  outdir: directory,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  outExtension: { ".js": ".mjs" },
  external: ["vue", "muvra"],
});
export const { dissolve, fade, glow, overlay } = await import(
  pathToFileURL(resolve(directory, "effects.mjs")).href
);
export const { waapiTransition } = await import(
  pathToFileURL(resolve(directory, "waapi.mjs")).href
);
