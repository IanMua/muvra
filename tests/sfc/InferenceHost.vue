<script setup lang="ts">
import { onBeforeUnmount, reactive, ref } from "vue";
import { PageStackView, useStackState } from "muvra";
import { stack } from "./catalog";

// pageProps 可以供应可选的展示值，但不会删减页面声明的导航输入或改变必填性。
const shared = reactive({ caption: "host-a" });
const confirmed = ref(""),
  closed = ref(""),
  accepted = ref(false);
const state = useStackState(stack);
const openContract = (name: "contract" | "lazy") =>
  stack.push({
    name,
    params: {
      orderNo: name === "lazy" ? "lazy-42" : "contract-42",
      note: null,
      onConfirm: (orderNo) => {
        confirmed.value = orderNo;
      },
      onClose: (orderNo) => {
        closed.value = orderNo;
      },
    },
  });
const openPopup = () =>
  stack.openPopup({
    name: "dialog",
    params: {
      message: "Typed callback",
      onConfirm: (value) => {
        accepted.value = value;
        void stack.closePopup();
      },
    },
  });
onBeforeUnmount(() => stack.dispose());
</script>

<template>
  <main>
    <h1>Page props inference</h1>
    <div class="toolbar">
      <button
        type="button"
        @click="stack.push({ name: 'orderDetail', params: { orderNo: 'order-42' } })"
      >
        Open inferred order
      </button>
      <button type="button" @click="openContract('contract')">Open input contract</button>
      <button type="button" @click="openContract('lazy')">Open lazy inferred order</button>
      <button
        type="button"
        @click="stack.switchTab({ name: 'orders', params: { customerId: 'customer-7' } })"
      >
        Switch inferred Tab
      </button>
      <button type="button" @click="openPopup">Open inferred popup</button>
      <button type="button" @click="shared.caption = 'host-b'">Update optional host caption</button>
      <button type="button" @click="stack.back()">Back inferred page</button>
    </div>
    <div class="inference-frame">
      <PageStackView :stack="stack" :page-props="shared" :transition="false" />
    </div>
    <p data-testid="confirmed">{{ confirmed }}</p>
    <p data-testid="closed">{{ closed }}</p>
    <p data-testid="accepted">{{ String(accepted) }}</p>
    <p data-testid="phase">{{ state.phase }}</p>
  </main>
</template>
