<script setup>
defineProps({ title: { type: String, default: '' }, parts: { type: Array, default: () => [] } });
</script>

<template>
  <span class="telegram-title-content">
    <template v-if="parts.length">
      <template v-for="(part, index) in parts" :key="index">
        <video
          v-if="part.type === 'emoji' && part.mediaType === 'video'"
          :src="part.src"
          :aria-label="part.alt"
          autoplay
          loop
          muted
          playsinline
        />
        <img v-else-if="part.type === 'emoji'" :src="part.src" :alt="part.alt" />
        <template v-else>{{ part.type === 'break' ? ' ' : part.text }}</template>
      </template>
    </template>
    <template v-else>{{ title }}</template>
  </span>
</template>

<style scoped>
.telegram-title-content img,
.telegram-title-content video {
  display: inline-block;
  width: 1.15em;
  height: 1.15em;
  object-fit: contain;
  vertical-align: -0.2em;
}
</style>
