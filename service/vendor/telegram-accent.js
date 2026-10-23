import path from 'node:path';
import sharp from 'sharp';

const colors = new Map();
export const DEFAULT_TELEGRAM_ACCENT = '#2aabee';
export const NEUTRAL_TELEGRAM_ACCENT = '#686868';

// Group similar hues instead of averaging the whole avatar into a muddy colour.
export function accentFromPixels(data) {
  const buckets = Array.from({ length: 24 }, () => ({ weight: 0, rgb: [0, 0, 0], count: 0 }));
  let hasOpaquePixels = false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] >= 128) hasOpaquePixels = true;
    const rgb = [data[i], data[i + 1], data[i + 2]].map((v) => v / 255);
    const max = Math.max(...rgb),
      min = Math.min(...rgb),
      delta = max - min;
    const lightness = (max + min) / 2;
    const saturation = delta / (1 - Math.abs(2 * lightness - 1) || 1);
    if (data[i + 3] < 128 || lightness < 0.12 || lightness > 0.88 || saturation < 0.25) continue;
    let hue =
      max === rgb[0]
        ? (rgb[1] - rgb[2]) / delta
        : max === rgb[1]
          ? (rgb[2] - rgb[0]) / delta + 2
          : (rgb[0] - rgb[1]) / delta + 4;
    hue = (hue * 60 + 360) % 360;
    const bucket = buckets[Math.round(hue / 15) % buckets.length];
    const weight = saturation ** 2 * (data[i + 3] / 255);
    bucket.weight += weight;
    bucket.count++;
    rgb.forEach((value, channel) => {
      bucket.rgb[channel] += value * weight;
    });
  }
  // Ignore tiny coloured compression artefacts in otherwise neutral images.
  const winner = buckets
    .filter((b) => b.count >= Math.max(2, (data.length / 4) * 0.005))
    .sort((a, b) => b.weight - a.weight)[0];
  if (!winner) return hasOpaquePixels ? NEUTRAL_TELEGRAM_ACCENT : DEFAULT_TELEGRAM_ACCENT;
  let rgb = winner.rgb.map((v) => v / winner.weight);
  const luminance = (values) =>
    values.reduce(
      (sum, v, i) =>
        sum + (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i],
      0,
    );
  // Keep the hue, but darken bright yellows/pastels for a readable QR on white.
  while (luminance(rgb) > 0.18) rgb = rgb.map((v) => v * 0.96);
  return (
    '#' +
    rgb
      .map((v) =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

export async function telegramAvatarAccent(avatar, assetDir) {
  const filename = /^\/telegram-media\/([a-f0-9]{64}\.(?:jpg|png|webp|gif))$/.exec(avatar || '')?.[1];
  if (!filename || !assetDir) return DEFAULT_TELEGRAM_ACCENT;
  const file = path.resolve(assetDir, filename);
  if (colors.has(file)) return colors.get(file);
  try {
    const pixels = await sharp(file, { limitInputPixels: 16_000_000, animated: false })
      .resize(64, 64, { fit: 'inside' })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer();
    const accent = accentFromPixels(pixels);
    colors.set(file, accent);
    if (colors.size > 256) colors.delete(colors.keys().next().value);
    return accent;
  } catch {
    // A missing/corrupt avatar must never prevent the widget from appearing.
    return DEFAULT_TELEGRAM_ACCENT;
  }
}
