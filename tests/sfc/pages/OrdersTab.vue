<script setup lang="ts">
// Tab 同样完整推导必填和可选输入，不借助目录字段名单。
const props = defineProps<{ customerId: string; caption?: string }>();
</script>

<template>
  <section class="page">
    <h2>Inferred Tab</h2>
    <p data-testid="customer-id">{{ props.customerId }}</p>
    <p data-testid="caption">{{ props.caption }}</p>
  </section>
</template>
