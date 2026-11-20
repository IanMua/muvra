<script setup lang="ts">
// 必填参数仍直接从公开 props 推导；扩展不会产生另一套导航输入。
defineProps<{ orderNo: string }>();
</script>
<template>
  <article class="layer-order">
    <span class="layer-eyebrow">PAGE LAYER</span>
    <h2>订单 {{ orderNo }}</h2>
    <p>普通页面完成进入后只显示自身，遮罩自动释放。</p>
  </article>
</template>
