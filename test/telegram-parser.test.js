import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";
import { parsePost } from "../service/vendor/telegram-preview.js";
import { accentFromPixels } from "../service/vendor/telegram-accent.js";

test("copied parser retains Telegram round videos and their duration", async (t) => {
  const assets = await mkdtemp(path.join(tmpdir(), "telegram-widget-round-"));
  t.after(() => rm(assets, { recursive: true, force: true }));
  const mp4 = Buffer.alloc(512);
  mp4.writeUInt32BE(24, 0);
  mp4.write("ftypmp42", 4);
  mp4.write("isommp42", 16);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
    "base64",
  );
  t.mock.method(
    globalThis,
    "fetch",
    async (url) => new Response(String(url).endsWith(".mp4") ? mp4 : png),
  );
  const $ =
    cheerio.load(`<div class="tgme_widget_message_wrap"><div class="js-widget_message" data-post="channel/1">
    <div class="tgme_widget_message_roundvideo_player">
      <i class="tgme_widget_message_roundvideo_thumb" style="background-image:url('https://cdn4.telesco.pe/file/round.png')"></i>
      <video class="tgme_widget_message_roundvideo" src="https://cdn4.telesco.pe/file/round.mp4"></video>
      <time class="tgme_widget_message_roundvideo_duration">0:58</time>
    </div></div></div>`);
  const post = await parsePost(
    $,
    $(".tgme_widget_message_wrap").get(0),
    assets,
  );
  assert.equal(post.mediaType, "round-video");
  assert.match(post.media, /\.mp4$/);
  assert.match(post.mediaPoster, /\.png$/);
  assert.equal(post.mediaDuration, "0:58");
});

test("copied parser retains text formatting, hashtags and inline buttons", async () => {
  const $ =
    cheerio.load(`<div class="tgme_widget_message_wrap"><div class="js-widget_message" data-post="channel/2">
    <div class="js-message_text"><b>Жирный</b><br><i>Курсив</i> <a class="hashtag">#telegram</a></div>
    <div class="tgme_widget_message_inline_keyboard"><div class="tgme_widget_message_inline_row">
      <a class="tgme_widget_message_inline_button url_button"><span class="tgme_widget_message_inline_button_text">Открыть</span></a>
    </div></div></div></div>`);
  const post = await parsePost($, $(".tgme_widget_message_wrap").get(0), "");
  assert.ok(
    post.content.some(
      (part) => part.text === "Жирный" && part.marks.includes("bold"),
    ),
  );
  assert.ok(
    post.content.some(
      (part) => part.text === "Курсив" && part.marks.includes("italic"),
    ),
  );
  assert.ok(
    post.content.some(
      (part) => part.text === "#telegram" && part.marks.includes("hashtag"),
    ),
  );
  assert.deepEqual(post.buttons, [[{ text: "Открыть", external: true }]]);
});

test("avatar accent algorithm remains available without a web server or database", () => {
  const pixels = Buffer.alloc(40 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 240;
    pixels[i + 1] = 25;
    pixels[i + 2] = 25;
    pixels[i + 3] = 255;
  }
  const value = accentFromPixels(pixels);
  assert.match(value, /^#[a-f0-9]{6}$/);
  assert.ok(
    Number.parseInt(value.slice(1, 3), 16) >
      Number.parseInt(value.slice(3, 5), 16),
  );
});
