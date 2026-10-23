import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { telegramAvatarAccent } from './telegram-accent.js';

const cache = new Map();
const assetDownloads = new Map();
const emojiCache = new Map();
const CACHE_TTL = 30 * 1000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 15 * 1024 * 1024;
const TELEGRAM_CACHE_MAX_AGE = 14 * 24 * 60 * 60 * 1000;
const TELEGRAM_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const assetExtensions = ['jpg', 'png', 'webp', 'gif', 'webm', 'mp4'];
const mimeExtensions = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['video/webm', 'webm'],
  ['video/mp4', 'mp4'],
]);

function cleanText(value, limit = 800) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, limit);
}

function httpsUrl(value) {
  if (!value) return '';
  const candidate = value.startsWith('//') ? `https:${value}` : value;
  try {
    const parsed = new URL(candidate, 'https://t.me');
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function styleImage(style) {
  const match = String(style || '').match(/background-image\s*:\s*url\((?:'|")?([^'")]+)(?:'|")?\)/i);
  return httpsUrl(match?.[1]);
}

export function parseInlineKeyboard($, message) {
  return message
    .find('.tgme_widget_message_inline_keyboard .tgme_widget_message_inline_row')
    .toArray()
    .slice(0, 8)
    .map((row) =>
      $(row)
        .find('.tgme_widget_message_inline_button')
        .toArray()
        .slice(0, 8)
        .map((button) => ({
          text: cleanText($(button).find('.tgme_widget_message_inline_button_text').text() || $(button).text(), 80),
          external: $(button).is('a.url_button'),
        }))
        .filter((button) => button.text),
    )
    .filter((row) => row.length);
}

function telegramAssetUrl(value) {
  const url = httpsUrl(value);
  if (!url) return '';
  const host = new URL(url).hostname.toLowerCase();
  return host === 't.me' ||
    host === 'telegram.org' ||
    host.endsWith('.telegram.org') ||
    host.endsWith('.telesco.pe') ||
    host.endsWith('.cdn-telegram.org') ||
    host.endsWith('.telegram-cdn.org')
    ? url
    : '';
}

async function existingAsset(assetDir, hash) {
  for (const extension of assetExtensions) {
    const filename = `${hash}.${extension}`;
    try {
      const file = path.join(assetDir, filename);
      await access(file);
      const now = new Date();
      await utimes(file, now, now).catch(() => {});
      return `/telegram-media/${filename}`;
    } catch {
      // Try the next supported format.
    }
  }
  return '';
}

export async function markTelegramAssetUsed(assetDir, filename) {
  if (!/^[a-f0-9]{64}\.(?:jpg|png|webp|gif|webm|mp4)$/.test(String(filename || ''))) return;
  const now = new Date();
  await utimes(path.join(assetDir, filename), now, now).catch(() => {});
}

export async function cleanupTelegramAssets(
  assetDir,
  { maxAgeMs = TELEGRAM_CACHE_MAX_AGE, maxBytes = TELEGRAM_CACHE_MAX_BYTES } = {},
) {
  await mkdir(assetDir, { recursive: true });
  const entries = await readdir(assetDir, { withFileTypes: true });
  const files = (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.(?:jpg|png|webp|gif|webm|mp4)$/.test(entry.name))
        .map(async (entry) => {
          const file = path.join(assetDir, entry.name);
          const details = await stat(file);
          return { file, name: entry.name, size: details.size, usedAt: details.mtimeMs };
        }),
    )
  ).sort((a, b) => a.usedAt - b.usedAt);

  const cutoff = Date.now() - maxAgeMs;
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let removedFiles = 0;
  let removedBytes = 0;
  for (const file of files) {
    if (file.usedAt >= cutoff && totalBytes <= maxBytes) continue;
    try {
      await unlink(file.file);
      totalBytes -= file.size;
      removedBytes += file.size;
      removedFiles += 1;
    } catch {
      // A concurrent preview may already be replacing or using this cache file.
    }
  }
  return { removedFiles, removedBytes, totalBytes };
}

async function cacheTelegramAsset(value, assetDir) {
  const url = telegramAssetUrl(value);
  if (!url || !assetDir) return '';
  const hash = createHash('sha256').update(url).digest('hex');
  const existing = await existingAsset(assetDir, hash);
  if (existing) return existing;
  if (assetDownloads.has(hash)) return assetDownloads.get(hash);

  const download = (async () => {
    await mkdir(assetDir, { recursive: true });
    const response = await fetch(url, {
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,video/webm,video/mp4,*/*' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Telegram media is unavailable');
    const declaredSize = Number(response.headers.get('content-length')) || 0;
    if (declaredSize > MAX_ASSET_BYTES) throw new Error('Telegram media is too large');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_ASSET_BYTES) throw new Error('Telegram media is too large');
    const detected = await fileTypeFromBuffer(buffer);
    const mime = detected?.mime || String(response.headers.get('content-type') || '').split(';')[0];
    const extension = detected?.ext === 'jpeg' ? 'jpg' : detected?.ext || mimeExtensions.get(mime);
    if (!assetExtensions.includes(extension)) throw new Error('Unsupported Telegram media format');
    const filename = `${hash}.${extension}`;
    await writeFile(path.join(assetDir, filename), buffer, { flag: 'wx' }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    return `/telegram-media/${filename}`;
  })();
  assetDownloads.set(hash, download);
  try {
    return await download;
  } finally {
    assetDownloads.delete(hash);
  }
}

async function customEmoji(emojiId, assetDir) {
  const id = String(emojiId || '');
  if (!/^\d{1,24}$/.test(id)) return null;
  const cacheKey = `${path.resolve(assetDir || '.')}::${id}`;
  if (!emojiCache.has(cacheKey)) {
    emojiCache.set(
      cacheKey,
      (async () => {
        const response = await fetch(`https://t.me/i/emoji/${id}.json`, {
          headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error('Telegram emoji is unavailable');
        const data = await response.json();
        const source = data.type === 'tgs' ? data.thumb : data.emoji || data.thumb;
        const src = await cacheTelegramAsset(source, assetDir);
        if (!src) throw new Error('Telegram emoji asset is unavailable');
        return { src, mediaType: data.type === 'webm' ? 'video' : 'image' };
      })().catch(() => null),
    );
  }
  return emojiCache.get(cacheKey);
}

function addText(parts, value, marks = []) {
  if (!value || parts.length >= 250) return;
  const text = String(value).slice(0, 8192);
  const previous = parts.at(-1);
  if (previous?.type === 'text' && previous.marks.join('|') === marks.join('|')) {
    previous.text = `${previous.text}${text}`.slice(0, 8192);
    return;
  }
  parts.push({ type: 'text', text, marks, src: '', mediaType: 'none', alt: '' });
}

function addBreak(parts) {
  if (parts.length >= 250) return;
  const trailingBreaks = parts.slice(-2).filter((part) => part.type === 'break').length;
  if (trailingBreaks < 2)
    parts.push({ type: 'break', text: '', marks: [], src: '', mediaType: 'none', alt: '' });
}

async function parseRichContent($, root, assetDir) {
  const parts = [];
  const hashtags = [];
  const markByTag = {
    b: 'bold',
    strong: 'bold',
    i: 'italic',
    em: 'italic',
    u: 'underline',
    s: 'strike',
    del: 'strike',
    code: 'code',
    pre: 'code',
    blockquote: 'quote',
  };

  async function walk(node, marks = []) {
    if (!node || parts.length >= 250) return;
    if (node.type === 'text') {
      addText(parts, node.data, marks);
      return;
    }
    const tag = String(node.name || '').toLowerCase();
    if (tag === 'br') {
      addBreak(parts);
      return;
    }
    if (tag === 'tg-emoji') {
      const alt = cleanText($(node).find('b').first().text() || $(node).text(), 16) || '✦';
      const asset = await customEmoji($(node).attr('emoji-id'), assetDir);
      if (asset)
        parts.push({ type: 'emoji', text: '', marks, src: asset.src, mediaType: asset.mediaType, alt });
      else addText(parts, alt, marks);
      return;
    }
    let hashtag = false;
    if (tag === 'a') {
      const label = cleanText($(node).text(), 96);
      if (/^#[^\s#]+$/u.test(label)) {
        if (!hashtags.includes(label) && hashtags.length < 20) hashtags.push(label);
        hashtag = true;
      }
    }
    if (
      tag === 'i' &&
      String($(node).attr('class') || '')
        .split(/\s+/)
        .includes('emoji')
    ) {
      const alt = cleanText($(node).find('b').first().text() || $(node).text(), 16);
      const src = await cacheTelegramAsset(styleImage($(node).attr('style')), assetDir).catch(() => '');
      if (src) parts.push({ type: 'emoji', text: '', marks, src, mediaType: 'image', alt });
      else addText(parts, alt, marks);
      return;
    }

    const mark = markByTag[tag];
    const nextMarks = [
      ...marks,
      ...(mark && !marks.includes(mark) ? [mark] : []),
      ...(hashtag && !marks.includes('hashtag') ? ['hashtag'] : []),
    ];
    const isBlock = ['blockquote', 'pre'].includes(tag);
    if (isBlock && parts.length && parts.at(-1)?.type !== 'break') addBreak(parts);
    for (const child of $(node).contents().toArray()) await walk(child, nextMarks);
    if (isBlock && parts.at(-1)?.type !== 'break') addBreak(parts);
  }

  for (const node of root.contents().toArray()) await walk(node);
  while (parts[0]?.type === 'break') parts.shift();
  while (parts.at(-1)?.type === 'break') parts.pop();
  const body = parts
    .map((part) => (part.type === 'break' ? '\n' : part.type === 'emoji' ? part.alt : part.text))
    .join('');
  const text = cleanText(body, 8192);
  return { text, content: parts, hashtags };
}

async function parseReaction($, reaction, assetDir) {
  const element = $(reaction);
  const custom = element.find('tg-emoji').first();
  const emoji = cleanText(element.find('b').first().text() || custom.text(), 16) || '✦';
  const clone = element.clone();
  clone.find('i.emoji, tg-emoji').remove();
  const count = cleanText(clone.text(), 24);
  const regular = element.find('i.emoji').first();
  const asset = custom.length
    ? await customEmoji(custom.attr('emoji-id'), assetDir)
    : regular.length
      ? {
          src: await cacheTelegramAsset(styleImage(regular.attr('style')), assetDir).catch(() => ''),
          mediaType: 'image',
        }
      : null;
  return {
    emoji,
    emojiAsset: asset?.src || '',
    emojiType: asset?.mediaType || 'none',
    count,
  };
}

function stylePixels(style, property) {
  const value = Number(
    String(style || '').match(new RegExp(`(?:^|;)\\s*${property}:\\s*([\\d.]+)px`, 'i'))?.[1],
  );
  return Number.isFinite(value) && value >= 0 && value <= 10000 ? value : 0;
}

async function parseAlbum($, message, assetDir) {
  const layer = message.find('.tgme_widget_message_grouped_layer').first();
  const width = stylePixels(layer.attr('style'), 'width');
  const height = stylePixels(layer.attr('style'), 'height');
  if (!width || !height) return [];
  const tiles = layer.find('.grouped_media_wrap').toArray().slice(0, 20);
  return (
    await Promise.all(
      tiles.map(async (element) => {
        const tile = $(element);
        const style = tile.attr('style');
        const x = stylePixels(style, 'left') / width;
        const y = stylePixels(style, 'top') / height;
        const w = stylePixels(style, 'width') / width;
        const h = stylePixels(style, 'height') / height;
        if (!w || !h || x + w > 1.01 || y + h > 1.01) return null;
        const video = tile.is('.tgme_widget_message_video_player') || tile.find('video').length > 0;
        const remote =
          styleImage(style) || styleImage(tile.find('.tgme_widget_message_video_thumb').attr('style'));
        const src = await cacheTelegramAsset(remote, assetDir).catch(() => '');
        return src
          ? { src, type: video ? 'video' : 'image', x, y, width: w, height: h, aspect: width / height }
          : null;
      }),
    )
  ).filter(Boolean);
}

async function postExcerpt(post) {
  if (!/^[a-zA-Z0-9_]{2,64}\/\d{1,20}$/.test(post)) return '';
  const response = await fetch(`https://t.me/${post}`, {
    headers: { accept: 'text/html', 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.7' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_HTML_BYTES) return '';
  const html = await response.text();
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) return '';
  const $ = cheerio.load(html);
  if (!$('[data-telegram-post]').toArray().some((node) => $(node).attr('data-telegram-post') === post)) return '';
  return cleanText($('meta[property="og:description"]').attr('content'), 8192);
}

export async function parsePost($, element, assetDir) {
  const message = $(element).find('.js-widget_message').first();
  const post = String(message.attr('data-post') || '');
  const sticker = message.find('.tgme_widget_message_sticker_wrap').first();
  const stickerVideo = sticker.find('video[src]').first();
  const stickerImage = sticker.find('img[src]').first();
  const stickerVideoUrl = httpsUrl(stickerVideo.attr('src'));
  const stickerImageUrl =
    httpsUrl(stickerImage.attr('src')) ||
    styleImage(sticker.find('[style*="background-image"]').first().attr('style'));
  const video = message.find('.tgme_widget_message_video_player').first();
  const round = message.find('.tgme_widget_message_roundvideo_player').first();
  const roundPoster = styleImage(round.find('.tgme_widget_message_roundvideo_thumb').attr('style'));
  const roundSource = httpsUrl(round.find('video').attr('src') || round.find('video source').attr('src'));
  const photo = message.find('.tgme_widget_message_photo_wrap').first();
  const linkPreview = message.find('.link_preview_image').first();
  const documentImage = message.find('.tgme_widget_message_document_thumb_wrap img').first();
  const remoteMedia =
    styleImage(video.find('.tgme_widget_message_video_thumb').attr('style')) ||
    styleImage(photo.attr('style')) ||
    styleImage(linkPreview.attr('style')) ||
    httpsUrl(documentImage.attr('src'));
  const [cachedMedia, richText, reactions, album] = await Promise.all([
    (async () => {
      if (round.length) {
        const [src, poster] = await Promise.all([
          cacheTelegramAsset(roundSource, assetDir).catch(() => ''),
          cacheTelegramAsset(roundPoster, assetDir).catch(() => ''),
        ]);
        return { src: src || poster, poster, type: src ? 'round-video' : poster ? 'round-image' : 'none' };
      }
      if (sticker.length) {
        const videoMedia = await cacheTelegramAsset(stickerVideoUrl, assetDir).catch(() => '');
        if (videoMedia) return { src: videoMedia, type: 'sticker-video' };
        const imageMedia = await cacheTelegramAsset(stickerImageUrl, assetDir).catch(() => '');
        return { src: imageMedia, type: imageMedia ? 'sticker-image' : 'none' };
      }
      const src = await cacheTelegramAsset(remoteMedia, assetDir).catch(() => '');
      return { src, type: video.length && src ? 'video' : src ? 'image' : 'none' };
    })(),
    parseRichContent($, message.find('.js-message_text').first(), assetDir),
    Promise.all(
      message
        .find('.tgme_reaction')
        .toArray()
        .slice(0, 4)
        .map((reaction) => parseReaction($, reaction, assetDir)),
    ),
    sticker.length ? [] : parseAlbum($, message, assetDir),
  ]);
  const unsupported = !richText.text && !cachedMedia.src && !album.length &&
    message.find('.message_media_not_supported').length > 0;
  const excerpt = unsupported ? await postExcerpt(post).catch(() => '') : '';
  const time = message.find('time.time').first();
  return {
    id: post || crypto.randomUUID(),
    service: message.hasClass('service_message'),
    url: post ? `https://t.me/${post}` : '',
    text: richText.text || excerpt || (unsupported ? 'Этот пост можно посмотреть в Telegram.' : ''),
    previewOnly: !!unsupported,
    hashtags: richText.hashtags,
    content: richText.content,
    media: cachedMedia.src,
    mediaType: cachedMedia.type,
    mediaPoster: cachedMedia.poster || '',
    mediaDuration: cleanText(round.find('.tgme_widget_message_roundvideo_duration').text(), 24),
    album,
    views: cleanText(message.find('.tgme_widget_message_views').first().text(), 32),
    time: cleanText(time.text(), 24),
    date: cleanText(time.attr('datetime'), 64),
    comments: cleanText(message.find('.tgme_widget_message_comments').first().text(), 32),
    reactions,
    buttons: parseInlineKeyboard($, message),
  };
}
async function telegramProfile(username, assetDir = '') {
  const key = String(username || '').toLowerCase();

  let response;

  try {
    response = await fetch(`https://t.me/${encodeURIComponent(key)}`, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'ru-RU,ru;q=0.9,en;q=0.7',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' + 'AppleWebKit/537.36 Chrome/131 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw Object.assign(new Error('Не удалось получить Telegram-профиль'), {
      statusCode: 502,
    });
  }

  if (!response.ok) {
    throw Object.assign(new Error('Telegram не вернул страницу профиля'), {
      statusCode: 502,
    });
  }

  const declaredSize = Number(response.headers.get('content-length')) || 0;

  if (declaredSize > MAX_HTML_BYTES) {
    throw Object.assign(new Error('Страница Telegram слишком большая'), {
      statusCode: 502,
    });
  }

  const html = await response.text();

  if (Buffer.byteLength(html) > MAX_HTML_BYTES) {
    throw Object.assign(new Error('Страница Telegram слишком большая'), {
      statusCode: 502,
    });
  }

  const $ = cheerio.load(html);

  const photoElement = $('.tgme_page_photo_image img').first();

  const avatarRemote =
    httpsUrl(photoElement.attr('src')) || httpsUrl($('meta[property="og:image"]').attr('content')) || '';

  const avatar = avatarRemote ? await cacheTelegramAsset(avatarRemote, assetDir).catch(() => '') : '';

  const title =
    cleanText($('.tgme_page_title').first().text(), 120) ||
    cleanText($('meta[property="og:title"]').attr('content'), 120) ||
    `@${key}`;

  const description =
    cleanText($('.tgme_page_description').first().text(), 400) ||
    cleanText($('meta[property="og:description"]').attr('content'), 400);

  return {
    mode: 'profile',

    url: `https://t.me/${key}`,
    username: `@${key}`,

    title,
    titleContent: (await parseRichContent($, $('.tgme_page_title').first(), assetDir)).content,
    avatar,
    description,

    subscribers: '',
    totalPosts: '',
    posts: [],

    accent: await telegramAvatarAccent(avatar, assetDir),
  };
}
export async function telegramPreview(username, postId = '', assetDir = '') {
  const key = String(username || '').toLowerCase();
  const requestedPost = String(postId || '');
  const cacheKey = `${path.resolve(assetDir || '.')}::${key}/${requestedPost}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL) return cached.value;

  let response;
  try {
    const sourceUrl = requestedPost
      ? `https://t.me/s/${encodeURIComponent(key)}/${requestedPost}`
      : `https://t.me/s/${encodeURIComponent(key)}`;
    response = await fetch(sourceUrl, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'ru-RU,ru;q=0.9,en;q=0.7',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw Object.assign(new Error('Не удалось получить страницу Telegram-канала'), { statusCode: 502 });
  }
  if (!response.ok) throw Object.assign(new Error('Telegram не вернул страницу канала'), { statusCode: 502 });
  const declaredSize = Number(response.headers.get('content-length')) || 0;
  if (declaredSize > MAX_HTML_BYTES)
    throw Object.assign(new Error('Страница Telegram слишком большая'), { statusCode: 502 });
  const html = await response.text();
  if (Buffer.byteLength(html) > MAX_HTML_BYTES)
    throw Object.assign(new Error('Страница Telegram слишком большая'), { statusCode: 502 });

  const $ = cheerio.load(html);
  const info = $('.tgme_channel_info').first();
  const messages = $('.tgme_widget_message_wrap').toArray();

  if (!info.length) {
    if (requestedPost) {
      throw Object.assign(new Error('Указанный пост Telegram не найден или недоступен публично.'), {
        statusCode: 404,
      });
    }

    const profile = await telegramProfile(key, assetDir);

    cache.set(cacheKey, {
      createdAt: Date.now(),
      value: profile,
    });

    if (cache.size > 100) {
      cache.delete(cache.keys().next().value);
    }

    return profile;
  }

  const avatarElement = info.find('.tgme_page_photo_image').first();
  const subscriberCount = cleanText(
    info.find('.tgme_channel_info_counter .counter_value').first().text(),
    32,
  );
  const selectedMessages = requestedPost
    ? messages.filter(
        (message) =>
          String($(message).find('.js-widget_message').first().attr('data-post') || '') ===
          `${key}/${requestedPost}`,
      )
    : messages.slice(-4);
  if (!selectedMessages.length && requestedPost)
    throw Object.assign(new Error('Указанный пост Telegram не найден или недоступен публично.'), {
      statusCode: 404,
    });
  const [parsedPosts, avatar] = await Promise.all([
    Promise.all(selectedMessages.map((message) => parsePost($, message, assetDir))),
    cacheTelegramAsset(avatarElement.find('img').attr('src'), assetDir).catch(() => ''),
  ]);
  const totalPosts =
    String(parsedPosts.at(-1)?.id || '')
      .split('/')
      .at(-1) || '';
  const value = {
    mode: 'channel',

    url: `https://t.me/${key}${requestedPost ? `/${requestedPost}` : ''}`,
    username: `@${key}`,
    title: cleanText(info.find('.tgme_channel_info_header_title').first().text(), 120) || `@${key}`,
    titleContent: (await parseRichContent($, info.find('.tgme_channel_info_header_title').first(), assetDir))
      .content,

    avatar,

    description: cleanText(info.find('.tgme_channel_info_description').first().text(), 400),

    subscribers: subscriberCount ? `${subscriberCount} подписчиков` : '',

    totalPosts,

    accent: await telegramAvatarAccent(avatar, assetDir),

    posts: parsedPosts,
  };
  cache.set(cacheKey, { createdAt: Date.now(), value });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return value;
}
