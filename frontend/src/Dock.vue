<script setup>
import { computed, ref, watch, onBeforeUnmount } from "vue";
import {
  Send,
  Star,
  Plus,
  X,
  RotateCcw,
  Eye,
  EyeOff,
  Link,
  Check,
} from "@lucide/vue";
import { api, useWidget } from "./connection.js";
import { telegramTarget } from "../../service/target.js";
const { state, connected } = useWidget();
const input = ref(""),
  error = ref(""),
  sending = ref(false),
  scale = ref(0.75),
  color = ref("#2aabee"),
  duration = ref(0);
const copying = ref(false);
let initialized = false,
  noticeTimer;
const active = computed(() => state.value.promo.active);
const replacing = computed(() => {
  if (!active.value) return false;
  try { return telegramTarget(input.value).url !== state.value.promo.url; }
  catch { return true; }
});
watch(state, (value) => {
  if (!initialized) {
    input.value = value.input;
    initialized = true;
  }
  scale.value = value.promo.scale || 0.75;
  color.value = value.promo.accentOverride || value.promo.accent || "#2aabee";
  duration.value = value.duration;
});
async function action(path, body = {}) {
  error.value = "";
  try {
    return await api(path, body);
  } catch (e) {
    error.value = e.message;
    return null;
  }
}
async function toggle() {
  if (sending.value) return;
  sending.value = true;
  try {
    await action("/toggle", { url: input.value });
  } finally {
    sending.value = false;
  }
}
let settingsTimer;
function settings(body) {
  clearTimeout(settingsTimer);
  pendingSettings = { ...pendingSettings, ...body };
  settingsTimer = setTimeout(() => {
    const data = pendingSettings;
    pendingSettings = {};
    void action("/settings", data);
  }, 100);
}
let pendingSettings = {};
async function copySource() {
  const url = new URL(location.href);
  url.pathname = "/overlay";
  try {
    await navigator.clipboard.writeText(url.href);
    copying.value = true;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      copying.value = false;
    }, 1800);
  } catch {
    error.value =
      "Не удалось скопировать. Адрес источника совпадает с адресом панели, замените /dock на /overlay.";
  }
}
onBeforeUnmount(() => {
  clearTimeout(settingsTimer);
  clearTimeout(noticeTimer);
});
</script>
<template>
  <main class="dock">
    <header class="dock-heading">
      <span class="telegram-mark"><Send :size="22" /></span>
      <div>
        <h1>Telegram</h1>
        <p>QR-код и публикации в эфире</p>
      </div>
      <span
        class="connection-dot"
        :class="{ online: connected }"
        :title="connected ? 'Подключено локально' : 'Переподключаемся…'"
      />
    </header>
    <form class="control-card" @submit.prevent="toggle">
      <label for="telegram-url">Ссылка на канал, профиль или пост</label>
      <div class="link-field">
        <Send :size="17" /><input
          id="telegram-url"
          v-model="input"
          maxlength="2048"
          autocomplete="off"
          spellcheck="false"
          placeholder="https://t.me/channel"
          @input="settings({ input: $event.target.value })"
        />
      </div>
      <div class="scale-label">
        <label for="scale">Масштаб</label
        ><strong>{{ Math.round(scale * 100) }}%</strong>
      </div>
      <input
        id="scale"
        v-model.number="scale"
        type="range"
        min="0.45"
        max="1.5"
        step="0.01"
        @input="settings({ scale: Number($event.target.value) })"
      />
      <div class="appearance-row">
        <div>
          <span>Цвет оформления</span
          ><small>{{
            state.promo.accentOverride
              ? "Свой цвет"
              : "Автоматически по аватару"
          }}</small>
        </div>
        <label class="color-picker" title="Выбрать цвет"
          ><input
            v-model="color"
            type="color"
            @input="settings({ accentOverride: $event.target.value })" /></label
        ><button
          v-if="state.promo.accentOverride"
          type="button"
          class="icon-button"
          title="Автоматический цвет"
          @click="settings({ accentOverride: '' })"
        >
          <RotateCcw :size="16" />
        </button>
      </div>
      <label for="duration">Автоматически скрывать</label>
      <select
        id="duration"
        v-model.number="duration"
        @change="settings({ duration: Number($event.target.value) })"
      >
        <option :value="0">Только вручную</option>
        <option :value="15">Через 15 секунд</option>
        <option :value="30">Через 30 секунд</option>
        <option :value="60">Через минуту</option>
        <option :value="120">Через 2 минуты</option>
      </select>
      <button
        class="show-button"
        :class="{ 'is-hide': active && !replacing }"
        :disabled="!connected || sending || state.busy || !input.trim()"
      >
        <EyeOff v-if="active && !replacing" :size="18" /><Eye
          v-else
          :size="18"
        />{{
          sending || state.busy
            ? "Загружаем…"
            : active && !replacing
              ? "Скрыть"
              : replacing
                ? "Заменить в эфире"
                : "Вывести в эфир"
        }}
      </button>
      <button
        v-if="state.busy"
        type="button"
        class="secondary"
        @click="action('/hide')"
      >
        Отменить загрузку
      </button>
    </form>
    <section class="favorites-card">
      <div class="section-heading">
        <h2><Star :size="15" />Избранные ссылки</h2>
        <button
          class="icon-button"
          :disabled="!input.trim() || !connected"
          title="Сохранить ссылку"
          @click="action('/favorites', { url: input })"
        >
          <Plus :size="18" />
        </button>
      </div>
      <div v-if="!state.favorites.length" class="empty-favorites">
        Добавьте ссылки, которые часто показываете на стриме.
      </div>
      <div
        v-for="item in state.favorites"
        :key="item.url"
        class="favorite"
        :class="{ active: active && state.promo.url === item.url }"
      >
        <button
          class="favorite-main"
          @click="
            input = item.url;
            settings({ input: item.url });
          "
        >
          <span class="favorite-avatar"><Send :size="16" /></span
          ><span
            ><strong>{{ item.title || `@${item.username}` }}</strong
            ><small>{{ item.url.replace("https://", "") }}</small></span
          ></button
        ><button
          class="icon-button"
          title="Удалить из избранного"
          @click="action('/favorites', { url: item.url, remove: true })"
        >
          <X :size="14" />
        </button>
      </div>
    </section>
    <footer class="dock-footer">
      <button class="secondary" @click="copySource">
        <Check v-if="copying" :size="14" /><Link v-else :size="14" />{{
          copying ? "Адрес скопирован" : "Скопировать адрес источника"
        }}</button
      ><span>1920 × 1080 · прозрачный фон</span>
    </footer>
    <div v-if="error || state.error" class="toast" role="alert">
      <span>{{ error || state.error }}</span
      ><button
        class="icon-button"
        title="Закрыть"
        @click="
          error = '';
          state.error = '';
        "
      >
        <X :size="15" />
      </button>
    </div>
    <p v-if="!connected" class="connection-notice">
      Подключаемся к локальному виджету…
    </p>
  </main>
</template>
