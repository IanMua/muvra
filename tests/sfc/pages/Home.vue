<script setup lang="ts">
// 没有业务参数的页面不要求导航调用额外传入 params。
defineProps<{ title?: string }>();
</script>

<template>
  <section class="page">
    <h2>Inference home</h2>
    <p>{{ title ?? "Ready" }}</p>
  </section>
</template>
