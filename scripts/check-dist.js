import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const assets = path.join(root, 'assets');
const files = readdirSync(assets);
const css = files.filter((file) => file.endsWith('.css')).map((file) => readFileSync(path.join(assets, file), 'utf8')).join('\n');
const js = files.filter((file) => file.endsWith('.js')).map((file) => readFileSync(path.join(assets, file), 'utf8')).join('\n');
assert.ok(!/url\([^)]*data:/i.test(css), 'CSP-incompatible inline CSS asset');
const fonts = [...css.matchAll(/url\(([^)]+\.woff2?[^)]*)\)/g)];
assert.ok(fonts.length > 0, 'Missing local fonts');
for (const [, quoted] of fonts) {
  const url = quoted.replaceAll('"', '').replaceAll("'", '').trim();
  assert.ok(url.startsWith('/assets/'), 'Font must be local');
  assert.ok(existsSync(path.join(root, url.slice(1))), 'Missing bundled font');
}
for (const animation of ['telegram-qr-float', 'telegram-feed-float', 'telegram-qr-in', 'telegram-qr-out'])
  assert.ok(css.includes(animation), `Missing original animation: ${animation}`);
assert.ok(files.some((file) => file.startsWith('telegram-pattern-')), 'Missing original wallpaper');
assert.ok(!js.includes('twitchbattle.ru'), 'Unexpected dependency on the original website');
assert.ok(!js.includes('StreamOverlay'), 'Unexpected dependency on the original project');
assert.ok(readFileSync(path.join(root, 'index.html'), 'utf8').includes('Telegram Widget'));
console.log(`Production assets OK: ${fonts.length} local font references, original animations and wallpaper, no website dependency.`);
