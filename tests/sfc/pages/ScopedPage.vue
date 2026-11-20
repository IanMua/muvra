<script setup lang="ts">
import { usePage } from "muvra";
import { stack } from "../catalog";

// 保留既有的目录上下文 API，并验证真实 SFC 与目录相互引用时仍能完成类型推导。
const props = defineProps<{ orderNo: string }>();
const context = usePage(stack, "scoped");
const id: string = context.params.value.orderNo;
</script>

<template>
  <section class="page">
    <h2>Scoped page</h2>
    <p>{{ props.orderNo }} / {{ id }}</p>
  </section>
</template>
