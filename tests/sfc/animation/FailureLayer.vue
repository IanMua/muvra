<script setup lang="ts">
import { onMounted } from "vue";
// 主动模拟组件挂载失败，确保异常进入转场降级与资源回收路径。
onMounted(() => {
  throw new Error("intentional-overlay-component-error");
});
</script>
<template><div>Broken overlay</div></template>
