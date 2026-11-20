<script setup lang="ts">
defineProps<{ message: string }>();
</script>
<template>
  <section class="scene scene-popup">
    <div class="popup-card">
      <h1>溶解弹窗</h1>
      <p>{{ message }}</p>
    </div>
  </section>
</template>
