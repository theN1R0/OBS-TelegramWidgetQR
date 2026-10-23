<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import QRCode from 'qrcode';
import TelegramTitle from './TelegramTitle.vue';
import { telegramExcerptParagraphs } from '../lib/telegram-excerpt.js';

const props = defineProps({
  promo: { type: Object, default: () => ({}) },
  clockOffset: { type: Number, default: 0 },
});

const now = ref(Date.now());
const qrSize = ref(0);
const qrPathData = ref('');
const loadedMedia = reactive(new Set());
const failedMedia = reactive(new Set());
const postListElement = ref(null);
const postScrollDistance = ref(0);
const postScrollTopOffset = 90;
const qrGradientId = `tg-qr-gradient-${Math.random().toString(36).slice(2, 9)}`;
const qrInset = 2;
let timer;

const displayPosts = computed(() =>
  (props.promo?.posts || []).map((post) => ({
    ...post,
    excerptParagraphs: telegramExcerptParagraphs(post),
  })),
);

const elapsed = computed(() => now.value + props.clockOffset - Number(props.promo?.changedAt || 0));
const leavingDuration = 520;
const visible = computed(() => {
  if (!props.promo?.revision || !props.promo?.url) return false;
  if (props.promo.active) return true;
  return elapsed.value > -1200 && elapsed.value < leavingDuration;
});
const isSpecificPost = computed(
  () =>
    props.promo?.mode === 'channel' &&
    props.promo?.posts?.length === 1 &&
    /^https:\/\/t\.me\/[^/]+\/\d+\/?$/.test(props.promo?.url || ''),
);
const postScrollDuration = computed(() => `${Math.max(10, Math.ceil(postScrollDistance.value / 34))}s`);
const accent = computed(() => props.promo?.accentOverride || props.promo?.accent || '#2aabee');
const animationStyle = computed(() => ({
  '--tg-delay': `${-elapsed.value}ms`,
  '--tg-accent': accent.value,
  '--tg-accent-glow': `${accent.value}66`,
  '--tg-scale': Math.min(1.5, Math.max(0.45, Number(props.promo?.scale) || 0.75)),
  '--tg-scroll-distance': `${postScrollDistance.value}px`,
  '--tg-scroll-duration': postScrollDuration.value,
  '--tg-scroll-top-offset': `${postScrollTopOffset}px`,
}));
function clamp(value, min = 0, max = 255) {
  return Math.min(max, Math.max(min, value));
}

function normalizeHexColor(value) {
  const hex = String(value || '')
    .trim()
    .replace(/^#/, '');

  if (/^[\da-f]{3}$/i.test(hex)) {
    return hex
      .split('')
      .map((char) => char + char)
      .join('');
  }

  if (/^[\da-f]{6}$/i.test(hex)) {
    return hex;
  }

  return null;
}

function hexToRgb(value) {
  const hex = normalizeHexColor(value);
  if (!hex) return null;

  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((channel) => clamp(Math.round(channel)).toString(16).padStart(2, '0')).join('')}`;
}

function mixRgb(a, b, amount) {
  return {
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  };
}

function getLuma({ r, g, b }) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const qrGradient = computed(() => {
  const base = hexToRgb(accent.value);

  if (!base) {
    return {
      start: accent.value,
      mid: accent.value,
      end: accent.value,
    };
  }

  const luma = getLuma(base);

  // Светлые акценты требуют более мягкого градиента.
  const startMix = luma > 0.72 ? 0.05 : 0.16;
  const endMix = luma > 0.72 ? 0.14 : 0.26;

  return {
    start: rgbToHex(mixRgb(base, { r: 255, g: 255, b: 255 }, startMix)),
    mid: accent.value,
    end: rgbToHex(mixRgb(base, { r: 0, g: 0, b: 0 }, endMix)),
  };
});
const qrViewBox = computed(() => `0 0 ${qrSize.value + qrInset * 2} ${qrSize.value + qrInset * 2}`);
const finderPositions = computed(() => {
  const size = qrSize.value;
  return size
    ? [
        [qrInset, qrInset],
        [size - 7 + qrInset, qrInset],
        [qrInset, size - 7 + qrInset],
      ]
    : [];
});

function isFinderCell(x, y, size) {
  return (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);
}

// Соседние QR-модули соединяются; скругляются только внешние углы.
function roundedModulePath(x, y, neighbors) {
  const { top, right, bottom, left } = neighbors;

  const r = 0.46;

  const topLeft = !top && !left ? r : 0;
  const topRight = !top && !right ? r : 0;
  const bottomRight = !bottom && !right ? r : 0;
  const bottomLeft = !bottom && !left ? r : 0;

  const commands = [];

  commands.push(`M ${x + topLeft} ${y}`);
  commands.push(`H ${x + 1 - topRight}`);

  if (topRight) {
    commands.push(`Q ${x + 1} ${y} ${x + 1} ${y + topRight}`);
  }

  commands.push(`V ${y + 1 - bottomRight}`);

  if (bottomRight) {
    commands.push(`Q ${x + 1} ${y + 1} ${x + 1 - bottomRight} ${y + 1}`);
  }

  commands.push(`H ${x + bottomLeft}`);

  if (bottomLeft) {
    commands.push(`Q ${x} ${y + 1} ${x} ${y + 1 - bottomLeft}`);
  }

  commands.push(`V ${y + topLeft}`);

  if (topLeft) {
    commands.push(`Q ${x} ${y} ${x + topLeft} ${y}`);
  }

  commands.push('Z');

  return commands.join(' ');
}

watch(
  () => props.promo?.url,
  (url) => {
    qrPathData.value = '';
    qrSize.value = 0;

    if (!url) return;

    try {
      const code = QRCode.create(url, {
        errorCorrectionLevel: 'H',
      });

      const size = code.modules.size;

      const isDark = (x, y) => {
        if (x < 0 || y < 0 || x >= size || y >= size) {
          return false;
        }

        if (isFinderCell(x, y, size)) {
          return false;
        }

        return code.modules.get(x, y);
      };

      const parts = [];

      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          if (!isDark(x, y)) continue;

          parts.push(
            roundedModulePath(x + qrInset, y + qrInset, {
              top: isDark(x, y - 1),
              right: isDark(x + 1, y),
              bottom: isDark(x, y + 1),
              left: isDark(x - 1, y),
            }),
          );
        }
      }

      qrSize.value = size;
      qrPathData.value = parts.join(' ');
    } catch {
      qrPathData.value = '';
      qrSize.value = 0;
    }
  },
  {
    immediate: true,
  },
);

watch(
  [visible, qrSize, isSpecificPost, () => props.promo?.posts?.[0]?.id],
  async (_values, _previousValues, onCleanup) => {
    let cancelled = false;
    let observer;
    onCleanup(() => {
      cancelled = true;
      observer?.disconnect();
    });
    postScrollDistance.value = 0;
    if (!visible.value || !qrSize.value || !isSpecificPost.value) return;

    await nextTick();
    if (cancelled) return;
    const list = postListElement.value;
    const post = list?.querySelector('.telegram-post');
    const viewport = list?.parentElement;
    if (!list || !post || !viewport) return;

    const measure = () => {
      const availableHeight = viewport.clientHeight - 17 - postScrollTopOffset;
      const overflow = post.offsetHeight - availableHeight;
      postScrollDistance.value = overflow > 4 ? Math.ceil(overflow) : 0;
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(viewport);
      observer.observe(post);
    }
  },
  { immediate: true, flush: 'post' },
);

onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 50);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div
    v-if="visible && qrSize"
    class="telegram-promo"
    :class="[
      promo.active ? 'is-visible' : 'is-hiding',
      {
        'is-profile': promo.mode === 'profile',
        'is-specific-post': isSpecificPost,
        'is-scrolling': isSpecificPost && postScrollDistance > 0,
      },
    ]"
    :style="animationStyle"
    aria-hidden="true"
  >
    <div class="telegram-promo-scale" :class="{ 'is-profile': promo.mode === 'profile' }">
      <div v-if="promo.mode === 'channel'" class="telegram-feed-motion">
        <section class="telegram-feed">
          <header class="telegram-feed-header">
            <div class="telegram-back">
              <svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
              <strong>{{ promo.totalPosts || promo.posts?.length || 0 }}</strong>
            </div>
            <div class="telegram-channel-pill">
              <strong><TelegramTitle :title="promo.title" :parts="promo.titleContent" /></strong>
              <span>{{ promo.subscribers || promo.username }}</span>
            </div>
            <span
              v-if="promo.avatar"
              class="telegram-feed-avatar"
              :class="{ 'is-loaded': loadedMedia.has(promo.avatar) }"
            >
              <img :src="promo.avatar" alt="" @load="loadedMedia.add(promo.avatar)" />
            </span>
            <span v-else class="telegram-feed-avatar fallback">{{ promo.title?.slice(0, 1) }}</span>
          </header>

          <div class="telegram-feed-wallpaper" />
          <div class="telegram-post-viewport">
            <div ref="postListElement" class="telegram-post-list">
              <article
                v-for="post in displayPosts"
                :key="post.id"
                class="telegram-post"
                :class="{
                  'is-sticker': post.mediaType?.startsWith('sticker-'),
                  'is-round': post.mediaType?.startsWith('round-'),
                  'is-service': post.service,
                }"
              >
                <div v-if="post.service" class="telegram-service-message">{{ post.text }}</div>
                <div v-else class="telegram-post-card">
                <strong class="telegram-post-author"
                  ><TelegramTitle :title="promo.title" :parts="promo.titleContent"
                /></strong>
                <div
                  v-if="post.album?.length"
                  class="telegram-post-album"
                  :style="{ aspectRatio: post.album[0].aspect }"
                >
                  <div
                    v-for="(tile, index) in post.album"
                    :key="`${post.id}-${index}`"
                    class="telegram-album-tile"
                    :class="{ 'is-loaded': loadedMedia.has(tile.src) }"
                    :style="{
                      left: `${tile.x * 100}%`,
                      top: `${tile.y * 100}%`,
                      width: `${tile.width * 100}%`,
                      height: `${tile.height * 100}%`,
                    }"
                  >
                    <img :src="tile.src" alt="" @load="loadedMedia.add(tile.src)" />
                    <span v-if="tile.type === 'video'" class="telegram-play">
                      <svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5V7Z" /></svg>
                    </span>
                  </div>
                </div>
                <div
                  v-else-if="post.media"
                  class="telegram-post-media"
                  :class="{
                    'is-sticker': post.mediaType?.startsWith('sticker-'),
                    'is-round': post.mediaType?.startsWith('round-'),
                    'is-loaded': loadedMedia.has(post.media),
                  }"
                >
                  <video
                    v-if="post.mediaType === 'sticker-video' || (post.mediaType === 'round-video' && !failedMedia.has(post.media))"
                    :src="post.media"
                    :poster="post.mediaPoster || undefined"
                    :aria-label="post.mediaType === 'round-video' ? 'Видеосообщение Telegram' : 'Стикер Telegram'"
                    autoplay
                    loop
                    muted
                    playsinline
                    @loadeddata="loadedMedia.add(post.media)"
                    @error="failedMedia.add(post.media)"
                  />
                  <img v-else :src="post.mediaType === 'round-video' ? post.mediaPoster : post.media" alt="" @load="loadedMedia.add(post.media)" />
                  <span v-if="post.mediaType?.startsWith('round-') && post.mediaDuration" class="telegram-round-duration">{{ post.mediaDuration }}</span>
                  <span v-if="post.mediaType === 'video'" class="telegram-play">
                    <svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5V7Z" /></svg>
                  </span>
                </div>
                <div v-if="post.content?.length" class="telegram-post-text">
                  <template v-for="(part, partIndex) in post.content" :key="`${post.id}-${partIndex}`">
                    <br v-if="part.type === 'break'" />
                    <video
                      v-else-if="part.type === 'emoji' && part.mediaType === 'video'"
                      class="telegram-inline-emoji"
                      :src="part.src"
                      :aria-label="part.alt"
                      autoplay
                      loop
                      muted
                      playsinline
                    />
                    <img
                      v-else-if="part.type === 'emoji'"
                      class="telegram-inline-emoji"
                      :src="part.src"
                      :alt="part.alt"
                    />
                    <span v-else :class="part.marks?.map((mark) => `mark-${mark}`)">{{ part.text }}</span>
                  </template>
                </div>
                <div v-else-if="post.excerptParagraphs.length" class="telegram-article-excerpt">
                  <h3>{{ post.excerptParagraphs[0] }}</h3>
                  <p v-for="(paragraph, index) in post.excerptParagraphs.slice(1)" :key="index">{{ paragraph }}</p>
                </div>
                <p v-else-if="post.text">{{ post.text }}</p>
                <div v-if="post.previewOnly" class="telegram-post-preview-note">Продолжение в Telegram ↗</div>
                <div class="telegram-post-meta">
                  <div class="telegram-reactions">
                    <span v-for="(reaction, reactionIndex) in post.reactions" :key="reactionIndex">
                      <video
                        v-if="reaction.emojiAsset && reaction.emojiType === 'video'"
                        class="telegram-reaction-emoji"
                        :src="reaction.emojiAsset"
                        :aria-label="reaction.emoji"
                        autoplay
                        loop
                        muted
                        playsinline
                      />
                      <img
                        v-else-if="reaction.emojiAsset"
                        class="telegram-reaction-emoji"
                        :src="reaction.emojiAsset"
                        :alt="reaction.emoji"
                      />
                      <template v-else>{{ reaction.emoji }}</template>
                      {{ reaction.count }}
                    </span>
                  </div>
                  <span class="telegram-views">
                    <svg viewBox="0 0 24 24">
                      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                      <circle cx="12" cy="12" r="2.5" />
                    </svg>
                    {{ post.views }} {{ post.time }}
                  </span>
                </div>
                <div v-if="post.comments" class="telegram-comments">Прокомментировать</div>
                </div>
                <div v-if="!post.service && post.buttons?.length" class="telegram-post-buttons">
                  <div v-for="(row, rowIndex) in post.buttons" :key="rowIndex" class="telegram-post-button-row">
                    <span v-for="(button, buttonIndex) in row" :key="buttonIndex" class="telegram-post-button">
                      {{ button.text }}
                      <svg v-if="button.external" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M5 3h8v8M13 3 4 12" />
                      </svg>
                    </span>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </section>
      </div>

      <section class="telegram-qr-column">
        <div class="telegram-qr-motion">
          <div class="telegram-qr-float">
            <div class="telegram-qr-card">
              <svg class="telegram-qr" :viewBox="qrViewBox" role="presentation">
                <defs>
                  <linearGradient
                    :id="qrGradientId"
                    gradientUnits="userSpaceOnUse"
                    :x1="0"
                    :y1="0"
                    :x2="qrSize + qrInset * 2"
                    :y2="qrSize + qrInset * 2"
                  >
                    <stop offset="0%" :stop-color="qrGradient.start" />
                    <stop offset="58%" :stop-color="qrGradient.mid" />
                    <stop offset="100%" :stop-color="qrGradient.end" />
                  </linearGradient>
                </defs>

                <rect :width="qrSize + qrInset * 2" :height="qrSize + qrInset * 2" rx="1.6" fill="#fff" />

                <path v-if="qrPathData" :d="qrPathData" :fill="`url(#${qrGradientId})`" />

                <g v-for="([x, y], index) in finderPositions" :key="index">
                  <rect :x="x" :y="y" width="7" height="7" rx="1.65" :fill="`url(#${qrGradientId})`" />
                  <rect :x="x + 1" :y="y + 1" width="5" height="5" rx="1.18" fill="#fff" />
                  <rect
                    :x="x + 2"
                    :y="y + 2"
                    width="3"
                    height="3"
                    rx="0.82"
                    :fill="`url(#${qrGradientId})`"
                  />
                </g>
              </svg>

              <span
                v-if="promo.avatar"
                class="telegram-qr-avatar"
                :class="{ 'is-loaded': loadedMedia.has(promo.avatar) }"
              >
                <img :src="promo.avatar" alt="" @load="loadedMedia.add(promo.avatar)" />
              </span>

              <span v-else class="telegram-qr-avatar fallback">
                {{ promo.username?.replace(/^@/, '').slice(0, 1).toUpperCase() }}
              </span>
            </div>
          </div>
          <div class="telegram-username-float">
            <strong class="telegram-username">{{ promo.username }}</strong>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.telegram-promo {
  position: absolute;
  z-index: 760;
  left: 50%;
  bottom: 34px;
  width: 0;
  pointer-events: none;
  color: #fff;
  font-family: Inter, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
}

.telegram-promo-scale {
  display: flex;
  width: 1410px;
  align-items: flex-end;
  justify-content: center;
  gap: 45px;
  zoom: var(--tg-scale);
  transform: translateX(-50%);
  transform-origin: center bottom;
}

.telegram-feed-motion {
  flex: 0 0 600px; /* ширина блока ленты */
  height: 920px;
}

.telegram-feed {
  position: relative;
  width: 100%;
  height: 920px;
  overflow: hidden;
  border: 2px solid #ffffff15;
  border-radius: 34px 34px 18px 18px;
  background: #122132;
  box-shadow:
    0 26px 80px #000a,
    inset 0 1px #ffffff1c;
  transform-origin: center bottom;
  animation: telegram-feed-float 8.3s cubic-bezier(0.45, 0.05, 0.55, 0.95) -2.2s infinite;
}

.telegram-feed-header {
  position: absolute;
  z-index: 3;
  inset: 0 0 auto;
  display: flex;
  height: 96px;
  align-items: center;
  justify-content: space-between;
  padding: 0 19px;
}

.telegram-back {
  display: flex;
  flex-shrink: 0;
  width: fit-content;
  min-width: 76px;
  min-height: 54px;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 0 13px 0 8px;
  border: 1px solid #ffffff24;
  border-radius: 55px;
  background: linear-gradient(145deg, #ffffff20, #a5c8bb0e);
  box-shadow:
    inset 0 1px #ffffff30,
    0 10px 28px #0004;
  backdrop-filter: blur(18px) saturate(145%);
  color: #dce7f2;
  font-size: 20px;
}

.telegram-back svg {
  width: 30px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2.4;
}

.telegram-channel-pill {
  flex: 0 1 auto;
  width: max-content;
  min-width: 0;
  margin: 0 8px;
  padding: 10px 24px;
  border: 1px solid #ffffff24;
  border-radius: 55px;
  background: linear-gradient(145deg, #ffffff20, #a5c8bb0e);
  box-shadow:
    inset 0 1px #ffffff30,
    0 10px 28px #0004;
  backdrop-filter: blur(18px) saturate(145%);
  text-align: center;
}

.telegram-channel-pill strong,
.telegram-channel-pill > span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.telegram-channel-pill strong {
  font-size: 20px;
  line-height: 1.1;
}

.telegram-channel-pill > span {
  margin-top: 5px;
  color: #9eb0c3;
  font-size: 14px;
}

.telegram-feed-avatar {
  position: relative;
  flex: 0 0 60px;
  width: 60px;
  height: 60px;
  justify-self: end;
  overflow: hidden;
  border: 2px solid #ffffff24;
  border-radius: 50%;
}

.telegram-feed-avatar img,
.telegram-qr-avatar img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.telegram-feed-avatar.fallback,
.telegram-qr-avatar.fallback {
  display: grid;
  place-items: center;
  background: var(--tg-accent);
  font-weight: 800;
}

.telegram-feed-wallpaper {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #0c0c0c;
}

.telegram-feed-wallpaper::before {
  position: absolute;
  inset: 0;
  background: #324937;
  content: '';
  opacity: 0.72;
  -webkit-mask-image: url('../assets/telegram-pattern.svg');
  -webkit-mask-position: center;
  -webkit-mask-repeat: repeat;
  -webkit-mask-size: 510px auto;
  mask-image: url('../assets/telegram-pattern.svg');
  mask-position: center;
  mask-repeat: repeat;
  mask-size: 510px auto;
}

.telegram-feed-wallpaper::after {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, #02070524, transparent 22%, transparent 78%, #02070538);
  content: '';
}

.telegram-post-viewport {
  position: absolute;
  z-index: 1;
  inset: 15px 0 0;
  overflow: hidden;
}

.telegram-post-viewport::before {
  content: '';
  position: absolute;
  z-index: 5;
  top: 0;
  right: 0;
  left: 0;
  height: 75px;
  pointer-events: none;
  background: linear-gradient(
    to bottom,
    rgba(5, 8, 9, 0.82) 20%,
    rgba(5, 8, 9, 0.55) 45%,
    rgba(5, 8, 9, 0.2) 70%,
    rgba(5, 8, 9, 0) 100%
  );
}

.telegram-post-list {
  position: absolute;
  top: 0;
  right: 22px;
  bottom: 17px;
  left: 22px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 13px;
  overflow: hidden;
  border-radius: 30px 30px 0 0;
}

.is-specific-post .telegram-post-list {
  top: 81px;
  justify-content: center;
}

.is-specific-post.is-scrolling .telegram-post-list {
  top: 0;
  justify-content: flex-start;
}

.is-specific-post.is-scrolling .telegram-post {
  animation: telegram-post-scroll var(--tg-scroll-duration) linear infinite alternate;
}

@keyframes telegram-post-scroll {
  0%,
  3% {
    transform: translateY(var(--tg-scroll-top-offset));
  }
  97%,
  100% {
    transform: translateY(calc(var(--tg-scroll-top-offset) - var(--tg-scroll-distance)));
  }
}

@media (prefers-reduced-motion: reduce) {
  .is-specific-post.is-scrolling .telegram-post {
    animation: none;
    transform: translateY(var(--tg-scroll-top-offset));
  }
}

.telegram-post {
  position: relative;
  flex: 0 0 auto;
  overflow: visible;
}

.telegram-post.is-service {
  align-self: center;
  max-width: 100%;
}

.telegram-service-message {
  width: fit-content;
  max-width: 100%;
  padding: 8px 17px;
  border: 1px solid #d7e8ff52;
  border-radius: 999px;
  background: linear-gradient(145deg, #96bae05c, #5279b083);
  box-shadow:
    inset 0 1px #ffffff50,
    0 7px 20px #0006;
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  color: #fff;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.3;
  text-align: center;
  text-shadow: 0 1px 4px #182b47b3;
  overflow-wrap: anywhere;
}

.telegram-post-card {
  overflow: visible;
  border: 1px solid #ffffff12;
  border-radius: 19px;
  background: #1d2226f2;
  box-shadow:
    0 8px 22px #0007,
    inset 0 1px #ffffff0a;
}

.telegram-post-author {
  display: block;
  padding: 15px 17px 10px;
  overflow: hidden;
  color: var(--tg-accent);
  font-size: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.telegram-post-media {
  position: relative;
  margin: 0 10px;
  overflow: hidden;
  border-radius: 14px;
  background: #0b1521;
}

.telegram-post-album {
  position: relative;
  margin: 0 10px;
  overflow: hidden;
  border-radius: 14px;
  background: #0b1521;
}

.telegram-album-tile {
  position: absolute;
  overflow: hidden;
}

.telegram-post-media:not(.is-loaded)::before,
.telegram-album-tile:not(.is-loaded)::before,
.telegram-feed-avatar:not(.fallback):not(.is-loaded)::before,
.telegram-qr-avatar:not(.fallback):not(.is-loaded)::before {
  position: absolute;
  z-index: 1;
  inset: 0;
  background: linear-gradient(100deg, #1b2835 10%, #304355 45%, #1b2835 80%);
  background-size: 200% 100%;
  content: '';
  animation: telegram-media-skeleton 1.5s ease-in-out infinite;
}

.telegram-post-media:not(.is-sticker):not(.is-round):not(.is-loaded) {
  aspect-ratio: 4 / 3;
}
.telegram-post-media.is-round {
  width: 340px;
  max-width: calc(100% - 20px);
  height: 340px;
  aspect-ratio: 1;
  margin: 0 auto;
  border-radius: 50%;
  box-shadow: 0 0 0 2px #ffffff30;
}
.telegram-post-media.is-round img,
.telegram-post-media.is-round video {
  height: 100%;
  object-fit: cover;
}
.telegram-post.is-round .telegram-post-card {
  background: transparent;
  border: 0;
  box-shadow: none;
}
.telegram-post.is-round .telegram-post-author {
  display: none;
}
.telegram-round-duration {
  position: absolute;
  z-index: 2;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 9px;
  border-radius: 999px;
  background: #142229a8;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.telegram-post-preview-note {
  margin: 12px 17px 4px;
  color: #8bd5ff;
  font-size: 14px;
  font-weight: 600;
}

.telegram-post-media:not(.is-loaded) > img,
.telegram-post-media:not(.is-loaded) > video {
  position: absolute;
  inset: 0;
  opacity: 0;
}

.telegram-album-tile:not(.is-loaded) > img {
  opacity: 0;
}

.telegram-feed-avatar:not(.fallback):not(.is-loaded) > img,
.telegram-qr-avatar:not(.fallback):not(.is-loaded) > img {
  opacity: 0;
}

@keyframes telegram-media-skeleton {
  to {
    background-position-x: -200%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .telegram-post-media:not(.is-loaded)::before,
  .telegram-album-tile:not(.is-loaded)::before,
  .telegram-feed-avatar:not(.fallback):not(.is-loaded)::before,
  .telegram-qr-avatar:not(.fallback):not(.is-loaded)::before {
    animation: none;
  }
}

.telegram-album-tile img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.telegram-post-media:not(.is-sticker):not(.is-round) img {
  height: auto;
}

.telegram-post-media img,
.telegram-post-media video {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.telegram-post-media.is-sticker {
  width: 310px;
  height: 310px;
  margin: 0;
  overflow: visible;
  background: transparent;
}

.telegram-post-media.is-sticker img,
.telegram-post-media.is-sticker video {
  object-fit: contain;
  object-position: left center;
}

.telegram-post.is-sticker .telegram-post-card {
  overflow: visible;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.telegram-post.is-sticker .telegram-post-author {
  display: none;
}

.telegram-post.is-sticker .telegram-post-meta {
  width: fit-content;
  min-height: 0;
  margin: -34px 0 0 218px;
  padding: 5px 9px;
  border-radius: 999px;
  background: #151b18d9;
  box-shadow: 0 4px 14px #0007;
  backdrop-filter: blur(12px);
}

.telegram-play {
  position: absolute;
  top: 50%;
  left: 50%;
  display: grid;
  width: 58px;
  height: 58px;
  place-items: center;
  border: 2px solid #fff8;
  border-radius: 50%;
  background: #0b1521a8;
  box-shadow: 0 8px 25px #0007;
  transform: translate(-50%, -50%);
}

.telegram-play svg {
  width: 32px;
  fill: #fff;
}

.telegram-post p,
.telegram-post-text {
  display: block;
  margin: 0;
  padding: 12px 17px 4px;
  color: #f1f5f9;
  font-size: 16px;
  line-height: 1.35;
  white-space: pre-wrap;
}

.telegram-article-excerpt {
  padding: 8px 17px 4px;
  color: #f1f5f9;
  overflow-wrap: anywhere;
}

.telegram-article-excerpt h3 {
  margin: 0 0 10px;
  font-size: 24px;
  font-weight: 500;
  line-height: 1.3;
}

.telegram-post .telegram-article-excerpt p {
  margin: 0 0 8px;
  padding: 0;
  font-size: 17px;
  font-weight: 400;
  line-height: 1.45;
}

.telegram-article-excerpt p:last-child {
  margin-bottom: 0;
}

.telegram-post-text .mark-bold {
  font-weight: 800;
}

.telegram-post-text .mark-italic {
  font-style: italic;
}

.telegram-post-text .mark-underline {
  text-decoration: underline;
}

.telegram-post-text .mark-strike {
  text-decoration: line-through;
}

.telegram-post-text .mark-code {
  padding: 1px 4px;
  border-radius: 4px;
  background: #0c1825b8;
  font-family: 'Roboto Mono', monospace;
}

.telegram-post-text .mark-quote {
  padding-left: 5px;
  border-left: 3px solid var(--tg-accent);
}

.telegram-post-text .mark-spoiler {
  border-radius: 3px;
  background: #7d91a7;
  color: transparent;
}

.telegram-post-text .mark-hashtag {
  color: #6abcf2;
}

.telegram-post-buttons {
  display: grid;
  gap: 5px;
  margin-top: 6px;
}

.telegram-post-button-row {
  display: flex;
  gap: 5px;
  min-width: 0;
}

.telegram-post-button {
  position: relative;
  display: grid;
  flex: 1 1 0;
  min-width: 0;
  min-height: 46px;
  align-items: center;
  justify-items: center;
  padding: 9px 25px;
  border-radius: 12px;
  background: #4c6895;
  color: #fff;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.2;
  text-align: center;
  overflow-wrap: anywhere;
}

.telegram-post-button svg {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 15px;
  height: 15px;
  fill: none;
  stroke: #19344e;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.7;
}

.telegram-inline-emoji,
.telegram-reaction-emoji {
  display: inline-block;
  width: 1.25em;
  height: 1.25em;
  object-fit: contain;
  vertical-align: -0.23em;
}

.telegram-post-meta {
  display: flex;
  min-height: 42px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 16px 9px;
  color: #7f96aa;
  font-size: 13px;
}

.telegram-reactions {
  display: flex;
  gap: 7px;
}

.telegram-reactions span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 9px;
  border-radius: 999px;
  background: #294158;
  color: #dbe8f3;
}

.telegram-views {
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}

.telegram-views svg {
  width: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
}

.telegram-comments {
  margin-top: 2px;
  padding: 13px 18px;
  border-top: 1px solid #ffffff0d;
  color: #82a9cd;
  font-size: 15px;
}

.telegram-qr-column {
  display: flex;
  flex: 0 0 550px;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  padding-bottom: 34px;
  transform: translateY(-70px);
}

.telegram-qr-motion {
  width: 520px;
  height: 578px;
}

.telegram-qr-float {
  display: flex;
  width: 520px;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  transform-origin: center bottom;
  animation: telegram-qr-float 7.1s cubic-bezier(0.45, 0.05, 0.55, 0.95) -4.35s infinite;
}

.telegram-qr-card {
  position: relative;
  display: grid;
  width: 520px;
  height: 520px;
  place-items: center;
  border: 0;
  border-radius: 30px;
  background: #fff;
  box-shadow:
    0 0 48px 5px var(--tg-accent-glow),
    0 24px 80px #0009;
}

.telegram-qr {
  width: 520px;
  height: 520px;
  display: flex;
}

.telegram-qr-avatar {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 98px;
  height: 98px;
  overflow: hidden;
  border: 7px solid var(--tg-accent);
  border-radius: 50%;
  box-shadow: 0 8px 28px #0004;
  transform: translate(-50%, -50%);
}

.telegram-username-float {
  display: flex;
  justify-content: center;
  margin-top: 20px;
  animation: telegram-username-float 9.7s cubic-bezier(0.45, 0.05, 0.55, 0.95) -1.8s infinite;
}

@keyframes telegram-username-float {
  0%,
  100% {
    transform: translate(-5px, 2px) rotate(1deg);
  }
  19% {
    transform: translate(7px, -7px) rotate(2.2deg);
  }
  43% {
    transform: translate(-3px, -12px) rotate(-0.8deg);
  }
  71% {
    transform: translate(9px, 5px) rotate(1.7deg);
  }
  87% {
    transform: translate(1px, -3px) rotate(-0.4deg);
  }
}

.telegram-username {
  max-width: 550px;
  padding: 9px 24px 10px;
  overflow: hidden;
  border: 1px solid #ffffff24;
  border-radius: 999px;
  background: linear-gradient(145deg, #ffffff24, #d8fff00c);
  color: #fff;
  font-size: 34px;
  line-height: 1.1;
  text-align: center;
  text-overflow: ellipsis;
  box-shadow:
    inset 0 1px #ffffff38,
    0 9px 28px #0006;
  backdrop-filter: blur(18px) saturate(145%);
  text-shadow:
    0 5px 16px #000,
    0 0 14px #000b;
  white-space: nowrap;
}

.is-visible .telegram-feed-motion {
  animation: telegram-feed-in 680ms cubic-bezier(0.18, 0.9, 0.28, 1) var(--tg-delay) both;
}

.is-visible .telegram-qr-motion {
  animation: telegram-qr-in 650ms cubic-bezier(0.18, 0.9, 0.28, 1) calc(var(--tg-delay) + 110ms) both;
}

.is-visible .telegram-username {
  animation: telegram-name-in 380ms cubic-bezier(0.18, 0.9, 0.28, 1) calc(var(--tg-delay) + 270ms) both;
}

.is-hiding .telegram-feed-motion {
  animation: telegram-feed-out 430ms cubic-bezier(0.55, 0, 0.9, 0.35) var(--tg-delay) both;
}

.is-hiding .telegram-qr-motion {
  animation: telegram-qr-out 400ms cubic-bezier(0.55, 0, 0.9, 0.35) calc(var(--tg-delay) + 35ms) both;
}

.is-hiding .telegram-username {
  animation: telegram-name-out 230ms cubic-bezier(0.55, 0, 1, 0.45) calc(var(--tg-delay) + 10ms) both;
}
.telegram-promo-scale.is-profile {
  width: 520px;
  gap: 0;
}

.telegram-promo-scale.is-profile .telegram-qr-column {
  flex: 0 0 auto;
}
@supports not (zoom: 1) {
  .telegram-promo-scale {
    transform: translateX(-50%) scale(var(--tg-scale));
  }
}

@keyframes telegram-feed-in {
  from {
    opacity: 0.15;
    transform: translateY(1050px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes telegram-qr-in {
  from {
    opacity: 0.15;
    transform: translateY(1050px) scale(0.975);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes telegram-name-in {
  from {
    opacity: 0;
    transform: translateY(15px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes telegram-feed-out {
  from {
    opacity: 1;
    transform: translateY(0);
  }
  to {
    opacity: 0.1;
    transform: translateY(1050px);
  }
}

@keyframes telegram-qr-out {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0.1;
    transform: translateY(1050px) scale(0.985);
  }
}

@keyframes telegram-name-out {
  from {
    opacity: 1;
    transform: translateY(0);
  }
  to {
    opacity: 0;
    transform: translateY(18px);
  }
}

@keyframes telegram-feed-float {
  0%,
  100% {
    transform: translate3d(0, 0, 0) rotate(-1.8deg);
  }
  14% {
    transform: translate3d(-5px, -6px, 0) rotate(-2.05deg);
  }
  31% {
    transform: translate3d(4px, -2px, 0) rotate(-1.55deg);
  }
  49% {
    transform: translate3d(-3px, 5px, 0) rotate(-1.95deg);
  }
  68% {
    transform: translate3d(6px, -4px, 0) rotate(-1.5deg);
  }
  84% {
    transform: translate3d(-4px, 3px, 0) rotate(-2deg);
  }
}

@keyframes telegram-qr-float {
  0%,
  100% {
    transform: translate3d(0, 0, 0) rotate(1.8deg);
  }
  17% {
    transform: translate3d(5px, -5px, 0) rotate(2.05deg);
  }
  36% {
    transform: translate3d(-5px, 3px, 0) rotate(1.5deg);
  }
  53% {
    transform: translate3d(3px, -6px, 0) rotate(2deg);
  }
  74% {
    transform: translate3d(-6px, -2px, 0) rotate(1.55deg);
  }
  89% {
    transform: translate3d(5px, 4px, 0) rotate(2.1deg);
  }
}
</style>
