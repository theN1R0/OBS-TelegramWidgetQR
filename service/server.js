import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WidgetState } from "./state.js";
import {
  telegramPreview,
  cleanupTelegramAssets,
  markTelegramAssetUsed,
} from "./vendor/telegram-preview.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

async function localKey(dir) {
  const file = path.join(dir, "access.key");
  try {
    const key = (await readFile(file, "utf8")).trim();
    if (/^[a-f0-9]{64}$/.test(key)) return key;
    throw new Error(
      "Повреждён файл access.key. Восстановите его из резервной копии или удалите вручную.",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const key = randomBytes(32).toString("hex");
  await writeFile(file, key, { mode: 0o600, flag: "wx" });
  return key;
}
const sameKey = (a, b) =>
  typeof a === "string" &&
  /^[a-f0-9]{64}$/.test(a) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function jsonBody(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8192)
      throw Object.assign(new Error("Запрос слишком большой."), {
        statusCode: 413,
      });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("Некорректный JSON.");
  }
}

export async function startServer({
  dir = path.join(root, ".data"),
  port = 45871,
  preview,
  dist = path.join(root, "dist"),
} = {}) {
  await mkdir(dir, { recursive: true });
  const assetDir = path.join(dir, "telegram");
  await mkdir(assetDir, { recursive: true });
  const key = await localKey(dir);
  const state = new WidgetState({
    dir,
    preview:
      preview ||
      ((username, post) => telegramPreview(username, post, assetDir)),
  });
  await state.load();
  await cleanupTelegramAssets(assetDir);
  const cleanup = setInterval(
    () => cleanupTelegramAssets(assetDir).catch(() => {}),
    6 * 60 * 60 * 1000,
  );
  cleanup.unref();
  const clients = new Set();
  let origin;
  const sendState = (snapshot) => {
    const data = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 2 * 1024 * 1024) {
        client.destroy();
        clients.delete(client);
      } else client.write(data);
    }
  };
  state.on("change", sendState);
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": heartbeat\n\n");
  }, 15000);
  heartbeat.unref();
  const server = createServer(async (req, res) => {
    const json = (code, data) => {
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(data));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    );
    try {
      if (req.headers.host !== new URL(origin).host)
        return json(403, { message: "Недопустимый адрес." });
      const url = new URL(req.url, origin);
      const cookie = /(?:^|;\s*)tw_key=([a-f0-9]{64})(?:;|$)/.exec(
        req.headers.cookie || "",
      )?.[1];
      const presented =
        req.headers["x-widget-token"] || url.searchParams.get("key") || cookie;
      if (!sameKey(presented, key))
        return json(401, { message: "Откройте панель через плагин OBS." });
      if (url.searchParams.has("key"))
        res.setHeader(
          "Set-Cookie",
          `tw_key=${key}; HttpOnly; SameSite=Strict; Path=/`,
        );
      if (req.headers.origin && req.headers.origin !== origin)
        return json(403, { message: "Недопустимый источник запроса." });
      if (
        req.method !== "GET" &&
        req.method !== "HEAD" &&
        !sameKey(req.headers["x-widget-token"], key)
      )
        return json(403, { message: "Недопустимый ключ запроса." });
      if (url.pathname === "/api/state" && req.method === "GET")
        return json(200, state.snapshot());
      if (url.pathname === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(`data: ${JSON.stringify(state.snapshot())}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname.startsWith("/api/") && req.method === "POST") {
        const data = await jsonBody(req);
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new Error("Ожидается объект настроек.");
        switch (url.pathname) {
          case "/api/show":
            await state.show(data.url);
            break;
          case "/api/hide":
            await state.hide();
            break;
          case "/api/toggle":
            await state.toggle(data.url);
            break;
          case "/api/settings":
            state.settings(data);
            await state.save();
            break;
          case "/api/favorites":
            await state.favorite(data.url, data.remove === true);
            break;
          default:
            return json(404, { message: "Не найдено." });
        }
        return json(200, state.snapshot());
      }
      if (!["GET", "HEAD"].includes(req.method))
        return json(405, { message: "Метод не поддерживается." });
      let file;
      if (url.pathname.startsWith("/telegram-media/")) {
        const filename =
          /^\/telegram-media\/([a-f0-9]{64}\.(?:jpg|png|webp|gif|webm|mp4))$/.exec(
            url.pathname,
          )?.[1];
        if (!filename) return json(404, { message: "Не найдено." });
        file = path.join(assetDir, filename);
        void markTelegramAssetUsed(assetDir, filename);
      } else if (["/", "/dock", "/overlay"].includes(url.pathname))
        file = path.join(dist, "index.html");
      else if (/^\/assets\/[a-zA-Z0-9_.-]+$/.test(url.pathname))
        file = path.join(dist, url.pathname.slice(1));
      else return json(404, { message: "Не найдено." });
      let details;
      try {
        details = await stat(file);
      } catch {
        return json(404, {
          message: "Файл не найден. Выполните npm run build.",
        });
      }
      if (!details.isFile()) return json(404, { message: "Не найдено." });
      res.setHeader(
        "Content-Type",
        mime[path.extname(file)] || "application/octet-stream",
      );
      res.setHeader("Accept-Ranges", "bytes");
      let start = 0,
        end = details.size - 1;
      if (req.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!range || (!range[1] && !range[2])) {
          res.writeHead(416, { "Content-Range": `bytes */${details.size}` });
          return res.end();
        }
        if (range[1]) {
          start = Number(range[1]);
          if (range[2]) end = Math.min(end, Number(range[2]));
        } else start = Math.max(0, details.size - Number(range[2]));
        if (start > end || start >= details.size) {
          res.writeHead(416, { "Content-Range": `bytes */${details.size}` });
          return res.end();
        }
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${details.size}`);
      }
      res.setHeader("Content-Length", Math.max(0, end - start + 1));
      if (req.method === "HEAD" || details.size === 0) return res.end();
      const stream = createReadStream(file, { start, end });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      if (!res.headersSent)
        json(error.statusCode || 400, {
          message: error.message || "Ошибка локального виджета.",
        });
      else res.destroy();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    clearInterval(cleanup);
    clearInterval(heartbeat);
    await state.close();
    throw error;
  }
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    key,
    origin,
    server,
    async close() {
      clearInterval(cleanup);
      clearInterval(heartbeat);
      state.off("change", sendState);
      for (const client of clients) client.end();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await state.close();
    },
  };
}
