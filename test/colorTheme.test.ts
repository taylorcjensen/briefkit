import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { prepareColorTheme, type ColorThemeColor } from '../src/lib/colorTheme.ts';
import { makeTempDir, runBriefkit } from './helpers/process.ts';

test('ColorTheme sorts Base24 slots, keeps custom names, and recognizes legacy Base16 maps', () => {
  const base24 = prepareColorTheme({ scheme: {
    system: 'base24', name: 'Example',
    palette: { base17: 'ae6cbd', base0a: '#ecb445', base05: '#ddd', base00: { name: 'Ink', hex: '#18212B' } },
  } });
  assert.equal(base24.title, 'Example');
  assert.deepEqual(base24.groups.map(({ label, colors }) => [label, colors.map(({ id }) => id)]), [
    ['Neutrals', ['base00', 'base05']], ['Accents', ['base0A']], ['Base24 extension', ['base17']],
  ]);
  assert.equal(base24.groups[0].colors[0].label, 'Ink');
  assert.equal(base24.groups[0].colors[1].label, 'Foreground');
  assert.equal(base24.groups[0].colors[1].hex, '#DDDDDD');

  const legacy = prepareColorTheme({ scheme: { scheme: 'Legacy', author: 'An author', base07: 'eeeeee', base00: '222222' } });
  assert.equal(legacy.system, 'base16');
  assert.equal(legacy.title, 'Legacy');
  assert.deepEqual(legacy.groups[0].colors.map(({ id }) => id), ['base00', 'base07']);
  assert.equal(prepareColorTheme({ palette: { base11: '#000' } }).system, 'base24');
  assert.throws(() => prepareColorTheme({ system: 'base16', palette: { base17: '#FFF' } }), /not a base16 slot/);
  assert.throws(() => prepareColorTheme({ palette: { base0A: '#FFF', base0a: '#000' } }), /duplicate slot base0A/);
});

test('ColorTheme keeps author labels separate from exact and approximate names', () => {
  const { groups: [{ colors }] } = prepareColorTheme({
    formats: ['rgb', 'hsl', 'oklch'],
    palette: { paper: { name: 'Drafting paper', hex: '#FFEFD5' }, nearLava: '#B5332F', red: '#F00', lava: '#B5332E' },
  });
  assert.equal(colors[0].label, 'Drafting paper');
  assert.deepEqual(colors[0].colorName, { value: 'papayawhip', exact: true });
  assert.equal(colors[0].values[0].value, '255, 239, 213');
  assert.deepEqual(colors[1].colorName, { value: 'Molten Lava', exact: false });
  assert.deepEqual(colors[3].colorName, { value: 'Molten Lava', exact: true });
  assert.deepEqual(colors[2].values, [
    { label: 'RGB', value: '255, 0, 0' },
    { label: 'HSL', value: '0.0°, 100.0%, 50.0%' },
    { label: 'OKLCH', value: '62.8%, 0.2577, 29.2°' },
  ]);
});

test('ColorTheme preserves native bit depth and separates wide-gamut and HDR colors from copy hex', () => {
  const { groups: [{ colors: [ink, p3, pq, hlg] }] } = prepareColorTheme({ palette: {
    ink: { rgb: [4096, 12288, 24576], bitDepth: 16 },
    p3: { rgb: [1, 0.4, 0], space: 'display-p3' },
    pq: { rgb: [1023, 512, 0], bitDepth: 10, space: 'rec2100-pq', fallbackHex: '#FFEFD5' },
    hlg: { rgb: [0.5, 0.5, 0.5], space: 'rec2100-hlg', fallbackHex: '#888' },
  } });
  assert.equal(ink.hdr, false);
  assert.equal(ink.hex, '#103060');
  assert.deepEqual(ink.native, { label: 'sRGB · 16-bit', value: '4096, 12288, 24576' });
  // Browser reference: color(from color(display-p3 1 0.4 0) srgb r g b)
  // resolves to color(srgb 1.08125 0.343114 -0.189992) before clipping.
  assert.equal(p3.hex, '#FF5700');
  assert.equal(p3.css, 'color(display-p3 1 0.4 0)');
  assert.equal(pq.hdr, true);
  assert.equal(pq.hex, '#FFEFD5');
  assert.deepEqual(pq.colorName, { value: 'papayawhip', exact: true });
  const pqPng = Buffer.from(pq.hdrImage!.split(',')[1], 'base64');
  const hlgPng = Buffer.from(hlg.hdrImage!.split(',')[1], 'base64');
  assert.equal(pqPng.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual([...pqPng.subarray(24, 26)], [16, 2]); // RGB at 16 bits per channel.
  assert.deepEqual([...pqPng.subarray(41, 45)], [9, 16, 0, 1]); // Full-range PQ.
  assert.deepEqual([...hlgPng.subarray(41, 45)], [9, 18, 0, 1]); // Full-range HLG.
  const scanline = inflateSync(pqPng.subarray(57, 57 + pqPng.readUInt32BE(49)));
  assert.deepEqual([scanline.readUInt16BE(1), scanline.readUInt16BE(3), scanline.readUInt16BE(5)],
    [65535, Math.round(65535 * 512 / 1023), 0]);
  assert.equal(hlg.hexLabel, 'SDR hex');
  assert.equal(hlg.hex, '#888888');
});

test('ColorTheme reports invalid color inputs with the offending key', () => {
  const invalid: Array<[unknown, RegExp]> = [
    ['#1234', /sample:.*opaque sRGB/],
    [{ rgb: [1, 2, 3] }, /sample:.*normalized channels/],
    [{ rgb: [1024, 0, 0], bitDepth: 10 }, /sample:.*between 0 and 1023/],
    [{ rgb: [1, 0, 0], space: 'rec2100-pq' }, /sample:.*HDR fallbackHex/],
    [{ rgb: [1, 0, 0], space: 'not-a-space' }, /sample:.*unsupported RGB space/],
  ];
  for (const [sample, message] of invalid) {
    assert.throws(() => prepareColorTheme({ palette: { sample: sample as ColorThemeColor } }), message);
  }
});

test('the ColorTheme MDX export builds with YAML data and emits self-contained swatches', async (t) => {
  const tempDir = await makeTempDir('color-theme');
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const reportDir = path.join(tempDir, 'report');
  const outDir = path.join(tempDir, 'site');
  await fs.mkdir(path.join(reportDir, 'data'), { recursive: true });
  await fs.writeFile(path.join(reportDir, 'data', 'theme.yaml'), `system: base24
name: Sample YAML
palette:
  base0a: '#FFEFD5'
  base0b: '#B5332F'
  base17: '#B5332E'
`);
  await fs.writeFile(path.join(reportDir, 'index.mdx'), `---
title: Color themes
---

import { ColorTheme } from 'briefkit';
import theme from '@report/data/theme.yaml';

<ColorTheme scheme={theme} />
<ColorTheme palette={{ highlight: { space: 'rec2100-hlg', rgb: [0.5, 0.5, 0.5], fallbackHex: '#888' } }} />
`);

  const result = await runBriefkit(['build', reportDir, '--out', outDir]);
  assert.equal(result.exitCode, 0, result.stderr);
  const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
  assert.match(html, /<bk-color-theme[^>]*data-bk-system="base24"/);
  assert.match(html, /<button[^>]*data-copy-hex="#FFEFD5"/);
  assert.match(html, /<div class="bk-color-name">\s*papayawhip\s*<\/div>/);
  assert.match(html, /<div class="bk-color-name">\s*Molten Lava\s*<\/div>/);
  assert.match(html, /<div class="bk-color-name">\s*<i>Molten Lava<\/i>/);
  assert.doesNotMatch(html, /<dt>(?:Color|CSS|Closest) name/);
  assert.doesNotMatch(html, /role="tooltip"/);
  assert.match(html, /data-copy-palette="Sample YAML\n#FFEFD5  base0A · Yellow\n#B5332F  base0B · Green\n#B5332E  base17 · Bright magenta"/);
  assert.match(html, /data-copy-palette="Palette\n#888888  highlight \(SDR fallback\)"/);
  assert.match(html, /data-copy-hex="#888888"[^>]*>\s*<span class="bk-color-patch" style="background-color:#888888;/);
  assert.match(html, /<img class="bk-color-hdr" src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
  assert.match(html, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(html, /The Count’s Black/);
});
