<script setup lang="ts">
// 订单详情唯一的对外输入就是 orderNo，目录不再重复声明任何字段。
const props = defineProps<{ orderNo: string }>();
</script>

<template>
  <section class="page">
    <h2>Inferred order</h2>
    <p data-testid="order-no">{{ props.orderNo }}</p>
  </section>
</template>
