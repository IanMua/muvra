<script setup lang="ts">
import { inject, ref } from "vue";
import { defineExtension, usePage } from "muvra";
import { backdrop } from "muvra/extensions/backdrop";

const props = defineProps<{ title: string; dynamic?: boolean }>();
const page = usePage();
const expanded = ref(false);
const telemetry = inject<{ scripts: number }>("layer-telemetry");
let removeOverride: (() => void) | undefined;
function override() {
  removeOverride?.();
  // 只覆盖透明度，保留目录声明的颜色；getter 随页面状态实时变化。
  removeOverride = page.extend(backdrop({ opacity: () => (expanded.value ? 0.62 : 0.38) }));
}
function clear() {
  removeOverride?.();
  removeOverride = undefined;
}
if (props.dynamic) override();
page.extend(
  defineExtension({
    key: "card-appearance",
    setup(context) {
      if (telemetry) telemetry.scripts++;
      context.styles.bind(() => ({ borderRadius: expanded.value ? "0px" : "22px" }));
      context.onCleanup(() => {
        if (telemetry) telemetry.scripts--;
      });
    },
  }),
);
</script>

<template>
  <section class="layer-card" :data-title="title">
    <span class="layer-eyebrow">SCRIPT + DECLARATION</span>
    <h2>{{ title }}</h2>
    <p>目录配置颜色，页面脚本按展开状态调整透明度。</p>
    <label>实例内输入 <input :aria-label="`${title} draft`" /></label>
    <div class="layer-actions">
      <button @click="expanded = !expanded">{{ expanded ? "收起" : "展开" }}</button>
      <button @click="clear">撤销脚本覆盖</button>
      <button @click="override">恢复脚本覆盖</button>
    </div>
    <output>expanded: {{ expanded }}</output>
  </section>
</template>
