import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../service/server.js";

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "telegram-widget-http-"));
  const dist = path.join(dir, "web");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), "<html>local widget</html>");
  await writeFile(path.join(dist, "assets", "test.woff2"), "font");
  const app = await startServer({
    dir,
    dist,
    port: 0,
    preview: async (name) => ({
      url: `https://t.me/${name}`,
      username: `@${name}`,
      posts: [],
      mode: "profile",
    }),
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const request = (url, options = {}) =>
    fetch(app.origin + url, {
      ...options,
      headers: { "X-Widget-Token": app.key, ...options.headers },
    });
  const command = (name, body = {}) =>
    request(`/api/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { ...app, request, command, dir };
}

test("local API requires a token and blocks foreign origins and cookie-only writes", async (t) => {
  const app = await setup(t);
  assert.equal((await fetch(app.origin + "/api/state")).status, 401);
  assert.equal(
    (
      await app.request("/api/state", {
        headers: { "X-Widget-Token": "wrong" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await app.request("/api/state", {
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(app.origin + "/api/hide", {
        method: "POST",
        headers: { Cookie: `tw_key=${app.key}` },
        body: "{}",
      })
    ).status,
    403,
  );
  const response = await app.request("/api/state");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(
    response.headers.get("content-security-policy"),
    /font-src 'self'/,
  );
});

test("authenticated dock, overlay and local assets are served without the original website", async (t) => {
  const app = await setup(t);
  const response = await fetch(`${app.origin}/dock?key=${app.key}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.match(await response.text(), /local widget/);
  assert.equal((await app.request("/overlay")).status, 200);
  assert.equal(
    (await app.request("/assets/test.woff2")).headers.get("content-type"),
    "font/woff2",
  );
  for (const url of [
    "/service/main.js",
    "/access.key",
    "/state.json",
    "/assets/nope",
    "/telegram-media/../state.json",
  ])
    assert.equal((await app.request(url)).status, 404);
});

test("show, live settings, favorites and hide share one state", async (t) => {
  const app = await setup(t);
  assert.equal((await app.command("show", { url: "@test" })).status, 200);
  const shown = await (await app.request("/api/state")).json();
  assert.equal(shown.promo.active, true);
  await app.command("settings", { scale: 1.1, accentOverride: "#123456" });
  await app.command("favorites", { url: "@test" });
  const changed = await (await app.request("/api/state")).json();
  assert.equal(changed.promo.revision, shown.promo.revision);
  assert.equal(changed.promo.scale, 1.1);
  assert.equal(changed.favorites.length, 1);
  assert.equal(
    (await app.command("settings", { scale: 1.3, duration: -1 })).status,
    400,
  );
  assert.equal(app.state.promo.scale, 1.1);
  await app.command("hide");
  assert.equal(app.state.promo.active, false);
  assert.equal((await app.command("missing")).status, 404);
});

test("SSE delivers initial state and live updates for dock and browser source", async (t) => {
  const app = await setup(t);
  const response = await app.request("/api/events");
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body.getReader();
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /"active":false/,
  );
  await app.command("settings", { scale: 1.3 });
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /"scale":1.3/,
  );
  await reader.cancel();
});

test("cached videos support byte ranges, suffix ranges and HEAD", async (t) => {
  const app = await setup(t);
  const filename = `${"a".repeat(64)}.mp4`;
  await writeFile(path.join(app.dir, "telegram", filename), "0123456789");
  const url = `/telegram-media/${filename}`;
  const response = await app.request(url, { headers: { Range: "bytes=2-5" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await response.text(), "2345");
  assert.equal(
    await (await app.request(url, { headers: { Range: "bytes=-3" } })).text(),
    "789",
  );
  assert.equal(
    (await app.request(url, { headers: { Range: "bytes=99-" } })).status,
    416,
  );
  assert.equal(
    (await app.request(url, { method: "HEAD" })).headers.get("content-length"),
    "10",
  );
});
