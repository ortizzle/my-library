// The install manifest: Android builds the installed app from it, so a
// missing icon or identity fails the install on the phone, not here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const shell = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));

test('the app has a fixed identity', () => {
  // Changing this makes phones treat the app as a different one; it was set
  // fresh to get past a stale install record. Don't change it casually.
  assert.equal(manifest.id, '/my-library/reading-room-2026'); // under this app's folder: other family apps share the origin
});

test('PNG icons at 192 and 512, and a maskable one, for Android', () => {
  const png = manifest.icons.filter(i => i.type === 'image/png');
  assert.ok(png.some(i => i.sizes === '192x192' && i.purpose === 'any'));
  assert.ok(png.some(i => i.sizes === '512x512' && i.purpose === 'any'));
  assert.ok(png.some(i => i.sizes === '512x512' && i.purpose === 'maskable'));
});

test('every icon exists and is published', () => {
  for (const i of manifest.icons) {
    assert.ok(existsSync(join(root, i.src)), `${i.src} exists`);
    assert.ok(shell.includes(`'./${i.src}'`), `${i.src} is in the service worker's SHELL list, so it deploys`);
  }
});

test('installable basics are set', () => {
  for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color'])
    assert.ok(manifest[k], k);
  assert.equal(manifest.display, 'standalone');
});
