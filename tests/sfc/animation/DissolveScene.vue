<script setup lang="ts">
// 页面只声明自己的导航输入；动画配置与页面内容保持独立。
defineProps<{ orderNo: string }>();
</script>
<template>
  <article class="scene scene-dissolve">
    <small>NOISE DISSOLVE</small>
    <h1>噪声溶解</h1>
    <p data-testid="effect-order-no">{{ orderNo }}</p>
    <div class="scene-orbit">溶</div>
    <p>固定噪声纹理 + 连续阈值，逐片显露真实 DOM。</p>
    <input aria-label="Dissolve draft" placeholder="取消动画后仍可操作" />
  </article>
</template>
