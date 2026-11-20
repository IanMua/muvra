<script setup lang="ts">
import { computed } from "vue";
import { usePage } from "muvra";

// 专门验证输入语义：note 可为 null 但必须传，其他可选字段与默认值保留 Vue 的公开契约。
const props = withDefaults(
  defineProps<{
    orderNo: string;
    note: string | null;
    section?: "detail" | "refund";
    compact?: boolean;
    caption?: string;
    onConfirm?: (orderNo: string) => void;
  }>(),
  { section: "detail" },
);
const emit = defineEmits<{ close: [orderNo: string] }>();
const context = usePage();
const raw = computed(() => context.params.value as Record<string, unknown>);
</script>

<template>
  <section class="page">
    <h2>Input contract</h2>
    <p data-testid="order-no">{{ props.orderNo }}</p>
    <p data-testid="note">{{ props.note === null ? "null" : props.note }}</p>
    <p data-testid="section">{{ props.section }}</p>
    <p data-testid="compact">{{ String(props.compact) }}</p>
    <p data-testid="caption">{{ props.caption }}</p>
    <p data-testid="raw-note">{{ Object.hasOwn(raw, "note") ? "present" : "absent" }}</p>
    <p data-testid="raw-caption">{{ Object.hasOwn(raw, "caption") ? "present" : "absent" }}</p>
    <p data-testid="raw-section">{{ Object.hasOwn(raw, "section") ? "present" : "absent" }}</p>
    <button type="button" @click="props.onConfirm?.(props.orderNo)">Confirm order callback</button>
    <button type="button" @click="emit('close', props.orderNo)">Emit order close</button>
  </section>
</template>
