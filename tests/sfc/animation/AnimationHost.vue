<script setup lang="ts">
import { onBeforeUnmount, provide } from "vue";
import { PageStackView, useStackState } from "muvra";
import type { createAnimationLab } from "./catalog";
const props = defineProps<{ lab: ReturnType<typeof createAnimationLab> }>();
const state = useStackState(props.lab.stack);
provide("animation-theme", "host-cyan-theme");
onBeforeUnmount(() => props.lab.stack.dispose());
</script>
<template>
  <main class="animation-lab">
    <header>
      <strong>Muvra · 动画</strong><span data-testid="effect-phase">{{ state.phase }}</span>
    </header>
    <div class="effect-frame">
      <PageStackView v-if="lab.visible.value" :stack="lab.stack" />
      <p v-else class="view-detached">视图已卸载，导航历史保留。</p>
    </div>
    <nav aria-label="动画演示">
      <button @click="lab.open('dissolve')">溶解进入</button>
      <button @click="lab.open('glow')">光效叠加</button>
      <button @click="lab.open('staged')">顺序编排</button>
      <button @click="lab.back()">返回</button>
      <button @click="lab.popup()">打开弹窗</button>
      <button @click="lab.secondPopup()">叠加弹窗</button>
      <button @click="lab.closePopup()">关闭弹窗</button>
      <button @click="lab.stack.cancel()">取消转场</button>
      <button @click="lab.abort()">Abort signal</button>
      <button @click="lab.visible.value = !lab.visible.value">
        {{ lab.visible.value ? "卸载视图" : "挂载视图" }}
      </button>
      <button @click="lab.stack.dispose()">销毁实例</button>
    </nav>
    <details>
      <summary>异常路径</summary>
      <button @click="lab.open('partial')">部分启动失败</button>
      <button @click="lab.open('broken')">组件异常</button>
      <button @click="lab.open('hanging')">超时演示</button>
    </details>
    <output data-testid="effect-result"
      >{{ lab.result.value?.status }} /
      {{ lab.result.value?.status === "completed" ? lab.result.value.transition : "" }}</output
    >
    <p class="effect-counters">
      Vue 图层：挂载 {{ lab.telemetry.mounted }} / 卸载 {{ lab.telemetry.unmounted }} / 活跃计时器
      {{ lab.telemetry.activeTimers }}
    </p>
    <output data-testid="effect-steps">{{ lab.steps.value.join(" → ") }}</output>
  </main>
</template>
