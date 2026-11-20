<script setup lang="ts">
// 回调是公开业务输入，不能把所有 onX 字段当成 Vue 内置事件剔除。
const props = defineProps<{ message: string; onConfirm: (accepted: boolean) => void }>();
</script>

<template>
  <section class="page">
    <h2>Inferred popup</h2>
    <p data-testid="popup-message">{{ props.message }}</p>
    <button type="button" @click="props.onConfirm(true)">Accept inferred popup</button>
  </section>
</template>
