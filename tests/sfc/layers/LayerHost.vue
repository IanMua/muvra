<script setup lang="ts">
import { onBeforeUnmount, provide } from "vue";
import { LayerStackView, PageStackView } from "muvra";
import type { createLayerLab } from "./catalog.js";
const props = defineProps<{ lab: ReturnType<typeof createLayerLab> }>();
provide("layer-telemetry", props.lab.telemetry);
onBeforeUnmount(() => props.lab.dispose());
</script>
<template>
  <main class="layer-lab">
    <header>
      <div>
        <span class="layer-eyebrow">PAGE STACK LAB .4</span>
        <h1>页面之下，是图层</h1>
      </div>
      <a href="/demo/effects.html">业务动画示例 ↗</a>
    </header>
    <div class="layer-columns">
      <section>
        <h3>导航 + 普通扩展</h3>
        <p>同名页面可叠加，遮罩只跟随实际前景。</p>
        <div class="layer-frame" data-navigation-frame><PageStackView :stack="lab.stack" /></div>
        <div class="layer-actions">
          <button @click="lab.popup('Popup A')">打开 A</button
          ><button @click="lab.popup('Popup B', false)">叠加 B</button
          ><button @click="lab.back">返回</button><button @click="lab.order">打开订单</button
          ><button @click="lab.blocked.value = true">拦截下次导航</button
          ><button @click="lab.stack.cancel">取消动画</button
          ><button @click="lab.reset">重置</button>
        </div>
      </section>
      <section>
        <h3>直接使用图层内核</h3>
        <p>下方三个图层没有页面名、历史或守卫。</p>
        <div class="layer-frame standalone-frame"><LayerStackView :stack="lab.scene" /></div>
        <label class="layer-slider"
          >透明度
          <input
            aria-label="Independent opacity"
            type="range"
            min="0"
            max="1"
            step="0.05"
            :value="lab.opacity.value"
            @input="lab.opacity.value = Number(($event.target as HTMLInputElement).value)"
          />{{ lab.opacity.value }}</label
        >
        <div class="layer-actions"><button @click="lab.removeShade">直接移除中间层</button></div>
      </section>
    </div>
    <footer>
      <pre data-testid="layer-telemetry">{{ lab.telemetry }}</pre>
      <pre data-testid="layer-result">{{ lab.result.value }}</pre>
    </footer>
  </main>
</template>
