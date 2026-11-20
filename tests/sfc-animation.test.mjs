import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { h } from "vue";
import { sfcPlugin } from "../scripts/sfc-plugin.mjs";
import { flush, mountView, text } from "./helpers.mjs";

test("真实动画 SFC：纯模板与 props 页面共用公开目录，关闭动画时不创建图层", async () => {
  await mkdir(resolve("reports/sfc"), { recursive: true });
  const directory = await mkdtemp(resolve("reports/sfc/animation-"));
  const filename = resolve(directory, "runtime.mjs");
  await build({
    entryPoints: ["tests/sfc/animation/runtime.ts"],
    outfile: filename,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    plugins: [sfcPlugin()],
    external: ["vue", "muvra"],
  });
  const { createAnimationLab, AnimationHost } = await import(pathToFileURL(filename).href);
  const lab = createAnimationLab({ disabled: true });
  await lab.stack.ready;
  const view = mountView(lab.stack, {}, () => h(AnimationHost, { lab }));
  assert.ok(text(view.root).includes("转场实验室"));
  const entered = await lab.open("dissolve");
  await flush();
  assert.equal(entered.transition, "skipped");
  assert.ok(text(view.root).includes("order-animation-42"));
  await lab.open("glow");
  await lab.popup();
  await lab.secondPopup();
  await flush();
  assert.deepEqual(
    lab.stack.getSnapshot().popups.map((route) => route.name),
    ["dialog", "secondDialog"],
  );
  await lab.closePopup();
  await lab.closePopup();
  await lab.back();
  await flush();
  assert.equal(lab.stack.getSnapshot().current.name, "dissolve");
  assert.deepEqual({ ...lab.telemetry }, { mounted: 0, unmounted: 0, activeTimers: 0 });
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.warnings, []);
  view.unmount();
  assert.equal(lab.stack.getSnapshot().disposed, true);
});
