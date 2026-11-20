import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { defineComponent, h } from "vue";
import { createPageStack, tab, page, usePage } from "../dist/index.js";
import { controllerFor } from "../dist/internal.js";
import { mountView, flush } from "./helpers.mjs";

test("重复挂载/卸载 30 次后，页面信号监听、生命周期和返回守卫均释放", async () => {
  let unloaded = 0;
  const component = defineComponent({
    setup() {
      const context = usePage();
      context.beforeBack(() => true);
      context.beforeLeave(() => true);
      context.onShow(() => {});
      context.onHide(() => {});
      context.onUnload(() => unloaded++);
      return () => h("p", "resources");
    },
  });
  const stack = createPageStack({ pages: { home: tab(component) }, initial: [{ name: "home" }] });
  await stack.ready;
  const record = controllerFor(stack).record(stack.getSnapshot().top.id);
  for (let index = 0; index < 30; index++) {
    const view = mountView(stack);
    await flush();
    assert.equal(getEventListeners(record.abort.signal, "abort").length, 1);
    view.unmount();
    assert.equal(getEventListeners(record.abort.signal, "abort").length, 0);
    for (const hooks of Object.values(record.hooks)) assert.equal(hooks.size, 0);
    assert.equal(record.leaveGuards.size, 0);
    assert.equal(record.backGuards.size, 0);
    assert.equal(view.root.children.length, 0);
  }
  assert.equal(unloaded, 30);
  stack.dispose();
});
test("已完成导航不保留调用者 AbortSignal 监听", async () => {
  const component = { render: () => null };
  const stack = createPageStack({
    pages: { home: tab(component), a: page(component) },
    initial: [{ name: "home" }],
  });
  await stack.ready;
  const abort = new AbortController();
  for (let index = 0; index < 50; index++) {
    await stack.push({ name: "a" }, { signal: abort.signal });
    await stack.back(1, { signal: abort.signal });
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  }
  stack.dispose();
});

test("销毁后仍持有 stack 时，渲染器时长回调捕获的资源可以被 GC", async () => {
  const { spawnSync } = await import("node:child_process");
  // 使用独立 GC 进程验证真实可回收性，避免只断言内部变量被置空而漏掉其他强引用。
  const script = `
    import assert from 'node:assert/strict';
    import {createPageStack,tab} from './dist/index.js';
    import {controllerFor} from './dist/internal.js';
    // 组件和空驱动放在资源作用域之外，避免测试夹具自身的闭包引入额外强引用。
    const blank={render:()=>null};
    const run=async()=>true;
    const durationFor=(resource)=>()=>resource.duration;
    async function fixture() {
      const resource={duration:10};
      const weak=new WeakRef(resource);
      const stack=createPageStack({pages:{home:tab(blank)},initial:[{name:'home'}]});
      await stack.ready;
      controllerFor(stack).attachRenderer(run,durationFor(resource));
      stack.dispose();
      return {stack,weak};
    }
    const retained=await fixture();
    for(let i=0;i<16;i++) { await new Promise(resolve=>setImmediate(resolve)); global.gc(); }
    assert.equal(retained.stack.getSnapshot().disposed,true);
    assert.equal(retained.weak.deref(),undefined,'disposed stack retains renderer closure');
  `;
  const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
});
