export function telegramTarget(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Укажите Telegram-канал или ссылку на него.");
  let username,
    postId = "";
  if (/^@?[a-zA-Z0-9_]{2,64}$/.test(raw)) username = raw.replace(/^@/, "");
  else {
    const candidate = /^(?:www\.)?(?:t\.me|telegram\.me)\//i.test(raw)
      ? `https://${raw}`
      : raw;
    let url;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error("Используйте @channel или https://t.me/channel.");
    }
    if (
      !["t.me", "telegram.me", "www.t.me", "www.telegram.me"].includes(
        url.hostname.toLowerCase(),
      ) ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error("Разрешены только ссылки на Telegram.");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0]?.toLowerCase() === "s") parts.shift();
    if (
      !/^[a-zA-Z0-9_]{2,64}$/.test(parts[0] || "") ||
      parts.length > 2 ||
      (parts[1] && !/^\d{1,20}$/.test(parts[1]))
    )
      throw new Error(
        "Ссылка должна вести на публичный Telegram-канал или публикацию.",
      );
    [username, postId = ""] = parts;
  }
  username = username.toLowerCase();
  return {
    username,
    postId,
    url: `https://t.me/${username}${postId ? `/${postId}` : ""}`,
  };
}
