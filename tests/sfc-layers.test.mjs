import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { h } from "vue";
import { build } from "esbuild";
import { sfcPlugin } from "../scripts/sfc-plugin.mjs";
import { find, flush, mountView, text } from "./helpers.mjs";

test("真实 SFC：声明与脚本扩展、同名弹窗、响应式样式、独立图层与清理", async () => {
  await mkdir(resolve("reports/sfc"), { recursive: true });
  const directory = await mkdtemp(resolve("reports/sfc/layers-"));
  const filename = resolve(directory, "runtime.mjs");
  await build({
    entryPoints: ["tests/sfc/layers/runtime.ts"],
    outfile: filename,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    plugins: [sfcPlugin()],
    external: ["vue", "muvra", "muvra/extensions/backdrop"],
  });
  const { createLayerLab, LayerHost } = await import(pathToFileURL(filename).href);
  const lab = createLayerLab({ duration: 0 });
  await lab.stack.ready;
  const view = mountView(lab.stack, {}, () => h(LayerHost, { lab }));
  await lab.popup("A");
  await flush();
  const mask = () =>
    find(view.root, (node) => Object.hasOwn(node.props, "data-page-stack-backdrop"));
  const button = (label) =>
    find(view.root, (node) => node.type === "button" && node.text === label);
  assert.equal(mask().style.background, "#17314f");
  assert.equal(mask().style.opacity, 0.38);
  button("展开").props.onClick();
  await flush();
  assert.equal(mask().style.opacity, 0.62);
  button("撤销脚本覆盖").props.onClick();
  await flush();
  assert.equal(mask().style.opacity, 0.22);
  await lab.popup("B", false);
  await flush();
  assert.equal(mask().style.opacity, 0.22);
  assert.deepEqual({ ...lab.telemetry }, { defaults: 2, scripts: 2 });
  await lab.back();
  await flush();
  assert.ok(text(view.root).includes("expanded: true"));
  assert.deepEqual({ ...lab.telemetry }, { defaults: 1, scripts: 1 });
  assert.equal(lab.scene.getSnapshot().layers.length, 3);
  lab.removeShade();
  await flush();
  assert.equal(lab.scene.getSnapshot().layers.length, 2);
  assert.equal(lab.stack.getSnapshot().popups.length, 1);
  await lab.back();
  await lab.order();
  await flush();
  assert.equal(mask(), undefined);
  assert.ok(text(view.root).includes("订单 42"));
  view.unmount();
  assert.deepEqual({ ...lab.telemetry }, { defaults: 0, scripts: 0 });
  assert.equal(lab.scene.signal.aborted, true);
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.warnings, []);
});
