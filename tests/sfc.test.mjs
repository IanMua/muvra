import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { h } from "vue";
import { sfcPlugin } from "../scripts/sfc-plugin.mjs";
import { find, flush, mountView, text } from "./helpers.mjs";

test("真实 SFC：订单号单一输入、必填可空、默认值、可选供值及懒加载完成实际挂载", async () => {
  await mkdir(resolve("reports/sfc"), { recursive: true });
  const directory = await mkdtemp(resolve("reports/sfc/props-"));
  const filename = resolve(directory, "runtime.mjs");
  await build({
    entryPoints: ["tests/sfc/runtime.ts"],
    outfile: filename,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    plugins: [sfcPlugin()],
    external: ["vue", "muvra"],
  });
  const { stack, InferenceHost } = await import(pathToFileURL(filename).href);
  await stack.ready;
  const view = mountView(stack, {}, () => h(InferenceHost));
  const value = (key) => text(find(view.root, (node) => node.props["data-testid"] === key));
  const click = async (label) => {
    // Vue 模板格式化会在长按钮文字两侧保留空白，按浏览器可访问名称的空白规则匹配。
    const button = find(
      view.root,
      (node) => node.type === "button" && text(node).replace(/\s+/g, " ").trim() === label,
    );
    assert.ok(button, label);
    await button.props.onClick();
    for (let index = 0; index < 5; index++) await flush();
  };
  await click("Open inferred order");
  assert.equal(value("order-no"), "order-42");
  assert.deepEqual(stack.getSnapshot().current.params, { orderNo: "order-42" });
  await click("Back inferred page");
  await click("Open input contract");
  assert.equal(value("order-no"), "contract-42");
  assert.equal(value("note"), "null");
  assert.equal(value("raw-note"), "present");
  assert.equal(value("section"), "detail");
  assert.equal(value("compact"), "false");
  assert.equal(value("caption"), "host-a");
  assert.equal(value("raw-caption"), "absent");
  assert.equal(value("raw-section"), "absent");
  await click("Confirm order callback");
  await click("Emit order close");
  assert.equal(value("confirmed"), "contract-42");
  assert.equal(value("closed"), "contract-42");
  await click("Update optional host caption");
  assert.equal(value("caption"), "host-b");
  // 同一个可选 prop 也能由导航提供，完整输入推导不依赖它的数据来源。
  await stack.replace({
    name: "contract",
    params: { orderNo: "replacement-42", note: "text", caption: "route-caption" },
  });
  await flush();
  assert.equal(value("note"), "text");
  assert.equal(value("caption"), "route-caption");
  assert.equal(value("raw-caption"), "present");
  await click("Back inferred page");
  await click("Open lazy inferred order");
  assert.ok(text(view.root).includes("Lazy inferred order"));
  assert.equal(value("order-no"), "lazy-42");
  assert.equal(value("note"), "null");
  assert.equal(value("section"), "refund");
  assert.equal(value("compact"), "false");
  assert.equal(value("caption"), "host-b");
  await click("Confirm order callback");
  assert.equal(value("confirmed"), "lazy-42");
  await click("Switch inferred Tab");
  assert.equal(value("customer-id"), "customer-7");
  assert.equal(value("caption"), "host-b");
  await click("Open inferred popup");
  assert.equal(value("popup-message"), "Typed callback");
  await click("Accept inferred popup");
  assert.equal(value("accepted"), "true");
  assert.equal(stack.getSnapshot().popups.length, 0);
  await stack.push({ name: "scoped", params: { orderNo: "scope-7" } });
  await flush();
  assert.ok(text(view.root).includes("scope-7 / scope-7"));
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.warnings, []);
  view.unmount();
  assert.equal(stack.getSnapshot().disposed, true);
});
