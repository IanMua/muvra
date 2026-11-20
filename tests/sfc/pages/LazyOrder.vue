<script setup lang="ts">
// 懒加载保留整个公开输入，note 的可空与必填互不替代。
const props = withDefaults(
  defineProps<{
    orderNo: string;
    note: string | null;
    section?: "detail" | "refund";
    compact?: boolean;
    caption?: string;
    onConfirm?: (orderNo: string) => void;
  }>(),
  { section: "refund" },
);
const emit = defineEmits<{ close: [orderNo: string] }>();
</script>

<template>
  <section class="page">
    <h2>Lazy inferred order</h2>
    <p data-testid="order-no">{{ props.orderNo }}</p>
    <p data-testid="note">{{ props.note === null ? "null" : props.note }}</p>
    <p data-testid="section">{{ props.section }}</p>
    <p data-testid="compact">{{ String(props.compact) }}</p>
    <p data-testid="caption">{{ props.caption }}</p>
    <button type="button" @click="props.onConfirm?.(props.orderNo)">Confirm order callback</button>
    <button type="button" @click="emit('close', props.orderNo)">Emit order close</button>
  </section>
</template>
