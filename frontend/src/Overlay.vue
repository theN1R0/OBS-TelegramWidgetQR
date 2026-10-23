<script setup>
import TelegramWidget from "./components/TelegramWidget.vue";
import { useWidget } from "./connection.js";
const { state, clockOffset } = useWidget();
</script>
<template>
  <main class="widget-canvas">
    <TelegramWidget
      :key="state.promo.url"
      :promo="state.promo"
      :clock-offset="clockOffset"
    />
  </main>
</template>
