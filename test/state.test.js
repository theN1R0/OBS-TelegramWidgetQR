import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { telegramTarget, WidgetState } from "../service/state.js";

const preview = async (username, postId) => ({
  url: `https://t.me/${username}${postId ? `/${postId}` : ""}`,
  username: `@${username}`,
  title: username,
  mode: "profile",
  accent: "#2aabee",
  posts: [],
});
async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "telegram-widget-state-"));
  const state = new WidgetState({
    dir,
    preview,
    wait: async () => {},
    ...options,
  });
  await state.load();
  t.after(async () => {
    await state.close();
    await rm(dir, { recursive: true, force: true });
  });
  return state;
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("accepts Telegram profiles, channels and posts; rejects arbitrary URLs and private invite paths", () => {
  for (const input of [
    "@My_Channel",
    "https://t.me/My_Channel",
    "telegram.me/My_Channel",
    "https://t.me/s/My_Channel",
  ])
    assert.equal(telegramTarget(input).url, "https://t.me/my_channel");
  assert.equal(
    telegramTarget("https://t.me/my_channel/123?single").postId,
    "123",
  );
  for (const input of [
    "",
    "https://evil.example/my_channel",
    "https://t.me.evil.example/test",
    "file:///test",
    "https://t.me/+private",
    "https://t.me/c/123/456",
    "https://t.me/test/123/extra",
    "https://u:p@t.me/test",
    "https://t.me:123/test",
  ])
    assert.throws(() => telegramTarget(input));
});

test("live scale and accent preserve revision and animation time", async (t) => {
  const state = await setup(t, { clock: () => 1000 });
  await state.show("@channel");
  const revision = state.promo.revision,
    changedAt = state.promo.changedAt;
  state.settings({ scale: 1.1, accentOverride: "#AB12EF" });
  assert.equal(state.promo.scale, 1.1);
  assert.equal(state.promo.accentOverride, "#ab12ef");
  assert.equal(state.promo.revision, revision);
  assert.equal(state.promo.changedAt, changedAt);
  assert.equal(changedAt, 1150);
  assert.equal(state.promo.active, true);
});

test("invalid settings patches cannot partially change live values", async (t) => {
  const state = await setup(t);
  assert.throws(() =>
    state.settings({ scale: 1.2, accentOverride: "invalid" }),
  );
  assert.equal(state.promo.scale, 0.75);
  for (const patch of [
    { scale: NaN },
    { scale: 1.6 },
    { duration: -1 },
    { duration: 2.5 },
    { input: 123 },
  ])
    assert.throws(() => state.settings(patch));
});

test("replacement closes the old widget before showing the new one", async (t) => {
  const closing = deferred();
  const state = await setup(t, { wait: () => closing.promise });
  await state.show("@first");
  const changing = state.show("@second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.promo.url, "https://t.me/first");
  assert.equal(state.promo.active, false);
  closing.resolve();
  await changing;
  assert.equal(state.promo.url, "https://t.me/second");
  assert.equal(state.promo.active, true);
});

test("hide cancels an in-flight Telegram request without a late reappearance", async (t) => {
  const pending = deferred();
  const state = await setup(t, { preview: () => pending.promise });
  const showing = state.show("@channel");
  await state.hide();
  pending.resolve(await preview("channel"));
  await showing;
  assert.equal(state.promo.active, false);
  assert.equal(state.busy, false);
});

test("a new show request lets an already running exit finish", async (t) => {
  let now = 1000;
  const waits = [];
  const state = await setup(t, {
    clock: () => now,
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  await state.show("@first");
  now = 2000;
  await state.hide();
  now = 2120;
  await state.show("@second");
  assert.deepEqual(waits, [400]);
  assert.equal(state.promo.url, "https://t.me/second");
});

test("newer requests win over slower previous requests", async (t) => {
  const pending = deferred();
  const state = await setup(t, {
    preview: (name) => (name === "first" ? pending.promise : preview(name)),
  });
  const first = state.show("@first");
  await state.show("@second");
  pending.resolve(await preview("first"));
  await first;
  assert.equal(state.promo.url, "https://t.me/second");
  assert.equal(state.promo.active, true);
});

test("failed Telegram request does not hide the currently playing widget", async (t) => {
  const state = await setup(t, {
    preview: (name) =>
      name === "bad"
        ? Promise.reject(new Error("Telegram unavailable"))
        : preview(name),
  });
  await state.show("@first");
  await assert.rejects(state.show("@bad"), /unavailable/);
  assert.equal(state.promo.active, true);
  assert.equal(state.promo.url, "https://t.me/first");
  assert.equal(state.busy, false);
});

test("toggle hides the same URL and replaces a different URL", async (t) => {
  const state = await setup(t);
  await state.toggle("@first");
  assert.equal(state.promo.active, true);
  await state.toggle("@first");
  assert.equal(state.promo.active, false);
  await state.toggle("@first");
  await state.toggle("@second");
  assert.equal(state.promo.url, "https://t.me/second");
});

test("favorites deduplicate and settings survive restart without automatically showing old posts", async (t) => {
  const state = await setup(t);
  await state.show("@channel");
  state.settings({ scale: 1.2, accentOverride: "#123456", duration: 30 });
  await state.favorite("@Channel");
  await state.favorite("https://t.me/channel");
  assert.equal(state.favorites.length, 1);
  const restarted = new WidgetState({ dir: state.dir, preview });
  await restarted.load();
  t.after(() => restarted.close());
  assert.equal(restarted.promo.scale, 1.2);
  assert.equal(restarted.promo.accentOverride, "#123456");
  assert.equal(restarted.input, "https://t.me/channel");
  assert.equal(restarted.promo.active, false);
  assert.equal(restarted.promo.revision, "");
  assert.equal(restarted.favorites.length, 1);
  assert.notEqual(restarted.instance, state.instance);
  await state.favorite("@channel", true);
  assert.equal(state.favorites.length, 0);
  assert.equal(
    JSON.parse(await readFile(path.join(state.dir, "state.json"), "utf8"))
      .favorites.length,
    0,
  );
});

test("automatic hide uses the ordinary exit animation state", async (t) => {
  const state = await setup(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  state.settings({ duration: 1 });
  await state.show("@channel");
  const revision = state.promo.revision;
  t.mock.timers.tick(1000);
  await state.persistence;
  assert.equal(state.promo.active, false);
  assert.notEqual(state.promo.revision, revision);
  assert.equal(state.promo.url, "https://t.me/channel");
});
