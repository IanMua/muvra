import { createRenderer, defineComponent, h, nextTick } from "vue";
import { PageStackView } from "../dist/index.js";

// 内存渲染器运行真实 Vue 组件和生命周期；真实布局、焦点及 WAAPI 另由浏览器套件验证。
export function mountView(stack, props = {}, rootRender) {
  const warnings = [],
    errors = [];
  const node = (type, text = "") => ({
    type,
    text,
    children: [],
    props: {},
    parent: null,
    style: {},
    querySelector(selector) {
      const id = /data-page-id="(\d+)"/.exec(selector)?.[1];
      return find(this, (n) => String(n.props["data-page-id"]) === id);
    },
  });
  const remove = (child) => {
    if (child.parent) {
      const index = child.parent.children.indexOf(child);
      if (index >= 0) child.parent.children.splice(index, 1);
    }
    child.parent = null;
  };
  const renderer = createRenderer({
    createElement: (type) => node(type),
    createText: (text) => node("text", text),
    createComment: (text) => node("comment", text),
    setText: (target, value) => {
      target.text = value;
    },
    setElementText: (target, value) => {
      target.text = value;
      target.children = [];
    },
    patchProp: (target, key, _before, value) => {
      target.props[key] = value;
      if (key === "style") target.style = value;
    },
    insert(child, parent, anchor) {
      remove(child);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : parent.children.length;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
    },
    remove,
    parentNode: (target) => target.parent,
    nextSibling: (target) => {
      const siblings = target.parent?.children ?? [];
      return siblings[siblings.indexOf(target) + 1] ?? null;
    },
  });
  const root = node("root");
  const app = renderer.createApp(
    defineComponent({
      setup: () => rootRender ?? (() => h(PageStackView, { stack, transition: false, ...props })),
    }),
  );
  app.config.warnHandler = (message) => warnings.push(message);
  app.config.errorHandler = (error) => errors.push(error);
  app.mount(root);
  return { root, warnings, errors, unmount: () => app.unmount() };
}
export function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children ?? []) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
export function text(root) {
  return (
    (root.type === "comment" ? "" : (root.text ?? "")) + (root.children ?? []).map(text).join("")
  );
}
export async function flush() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}
