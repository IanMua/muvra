<script setup lang="ts">
import { inject, onMounted, onUnmounted, ref } from "vue";
const props = defineProps<{
  telemetry: { mounted: number; unmounted: number; activeTimers: number };
}>();
const theme = inject<string>("animation-theme", "missing-context");
const ticks = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  props.telemetry.mounted++;
  props.telemetry.activeTimers++;
  timer = setInterval(() => ticks.value++, 30);
});
onUnmounted(() => {
  // 图层卸载时停止自身业务计时器，验证框架是否真正结束 Vue 组件生命周期。
  if (timer !== undefined) clearInterval(timer);
  props.telemetry.unmounted++;
  props.telemetry.activeTimers--;
});
</script>
<template>
  <div class="vue-glow-layer">
    <span data-testid="overlay-context">{{ theme }}</span>
    <span data-testid="overlay-ticks">{{ ticks }}</span>
  </div>
</template>
