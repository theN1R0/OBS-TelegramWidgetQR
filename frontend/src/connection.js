import { ref, onMounted, onBeforeUnmount } from "vue";

const key =
  new URLSearchParams(location.search).get("key") ||
  sessionStorage.getItem("tw_key") ||
  "";
if (key) sessionStorage.setItem("tw_key", key);

export async function api(path, body) {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Widget-Token": key,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.message || "Не удалось выполнить команду.");
  return result;
}
export function useWidget() {
  const state = ref({
    promo: {},
    favorites: [],
    input: "",
    duration: 0,
    busy: false,
  });
  const connected = ref(false),
    clockOffset = ref(0);
  let events;
  onMounted(() => {
    events = new EventSource(`/api/events?key=${encodeURIComponent(key)}`);
    events.onopen = () => {
      connected.value = true;
    };
    events.onerror = () => {
      connected.value = false;
    };
    events.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data);
        if (
          next.instance === state.value.instance &&
          next.sequence < (state.value.sequence ?? -1)
        )
          return;
        clockOffset.value = next.serverTime - Date.now();
        state.value = next;
      } catch {
        /* Ignore malformed transport data; reconnect is handled by EventSource. */
      }
    };
  });
  onBeforeUnmount(() => events?.close());
  return { state, connected, clockOffset };
}
