import { hexRgb, hsl, mapRgb, oklab, rgb8Hex, srgb8, toSrgb, type Rgb } from './colorMath.js';
import { matchColorName } from './colorNames.js';
import { hdrSwatchUrl, type HdrSpace } from './hdrSwatch.js';

export type ColorThemeSystem = 'base16' | 'base24';
export type ColorThemeFormat = 'rgb' | 'hsl' | 'oklch';
type SdrSpace = 'srgb' | 'srgb-linear' | 'display-p3' | 'rec2020';
type BitDepth = 8 | 10 | 12 | 16;

type Named = { name?: string };
type RGBColor = Named & { rgb: Rgb; bitDepth?: BitDepth; hex?: never };
export type ColorThemeColor = string
  | (Named & { hex: string; rgb?: never; space?: never; bitDepth?: never; fallbackHex?: never })
  | (RGBColor & { space?: SdrSpace; fallbackHex?: never })
  | (RGBColor & { space: HdrSpace; fallbackHex: string });

export type ColorThemePalette = Readonly<Record<string, ColorThemeColor>>;
export type ColorThemeScheme = { name?: string; author?: string; variant?: string; slug?: string } & (
  | { system?: ColorThemeSystem; palette: ColorThemePalette }
  | { readonly [slot: `base${string}`]: ColorThemeColor; scheme?: string; system?: ColorThemeSystem; palette?: never }
);

export type ColorThemeProps = { title?: string; formats?: readonly ColorThemeFormat[]; class?: string } & (
  | { palette: ColorThemePalette; system?: ColorThemeSystem; scheme?: never }
  | { scheme: ColorThemeScheme; palette?: never; system?: never }
);

const slots = [
  'Background', 'Alternate background', 'Selection', 'Comments', 'Muted foreground', 'Foreground', 'Light foreground', 'Lightest foreground',
  'Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Magenta', 'Dark red / brown',
  'Extra background', 'Extreme background', 'Bright red', 'Bright yellow', 'Bright green', 'Bright cyan', 'Bright blue', 'Bright magenta',
];
const groupLabels = ['Neutrals', 'Accents', 'Base24 extension'] as const;
const baseSlot = /^base([0-9a-f]{2})$/i;
const spaceLabels = {
  srgb: 'sRGB', 'srgb-linear': 'Linear sRGB', 'display-p3': 'Display P3', rec2020: 'Rec. 2020',
  'rec2100-pq': 'Rec. 2100 PQ', 'rec2100-hlg': 'Rec. 2100 HLG',
} as const;
const formatLabels = { rgb: 'RGB', hsl: 'HSL', oklch: 'OKLCH' } as const;

function hexCode(value: unknown, field: string): string {
  if (typeof value === 'string') {
    const hex = value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(hex)) return `#${hex.replace(/^#/, '').toUpperCase()}`;
    if (/^#[0-9a-f]{3}$/i.test(hex)) return '#' + [...hex.slice(1).toUpperCase()].map(c => c + c).join('');
  }
  throw new Error(`${field} must be opaque sRGB hex (#RGB or #RRGGBB).`);
}

function formatValue(format: ColorThemeFormat, rgb8: Rgb): string {
  if (format === 'rgb') return rgb8.join(', ');
  const rgb = mapRgb(rgb8, value => value / 255);
  if (format === 'hsl') {
    const [h, s, l] = hsl(rgb);
    return `${h === undefined ? 'none' : `${h.toFixed(1)}°`}, ${(s * 100).toFixed(1)}%, ${(l * 100).toFixed(1)}%`;
  }
  const [l, a, b] = oklab(rgb);
  const chroma = Math.hypot(a, b);
  const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  return `${(l * 100).toFixed(1)}%, ${chroma.toFixed(4)}, ${chroma < 0.00005 ? 'none' : `${hue.toFixed(1)}°`}`;
}

function normalizeColor(color: ColorThemeColor) {
  if (typeof color === 'string') return { hex: hexCode(color, 'color'), hdr: false };
  if (!color || typeof color !== 'object' || Array.isArray(color)) throw new Error('use a hex string or a color object.');
  const { name, rgb, hex, bitDepth, space = 'srgb', fallbackHex } = color;
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw new Error('name must be a nonempty string.');
  if (hex !== undefined) {
    if (rgb !== undefined || color.space !== undefined || bitDepth !== undefined || fallbackHex !== undefined) {
      throw new Error('hex cannot be combined with RGB options.');
    }
    return { name, hex: hexCode(hex, 'hex'), hdr: false };
  }
  if (!Object.hasOwn(spaceLabels, space)) throw new Error(`unsupported RGB space "${space}".`);
  if (bitDepth !== undefined && ![8, 10, 12, 16].includes(bitDepth)) throw new Error('bitDepth must be 8, 10, 12, or 16.');
  const max = bitDepth === undefined ? 1 : 2 ** bitDepth - 1;
  if (!Array.isArray(rgb) || rgb.length !== 3 || [...rgb].some(value =>
    !Number.isFinite(value) || value < 0 || value > max || (bitDepth !== undefined && !Number.isInteger(value)))) {
    throw new Error(bitDepth === undefined
      ? 'rgb must contain three normalized channels between 0 and 1 (or set bitDepth for integer RGB).'
      : `rgb must contain three full-range integer channels between 0 and ${max} at ${bitDepth} bits.`);
  }
  const normalized = mapRgb(rgb, value => value / max);
  const hdr = space === 'rec2100-pq' || space === 'rec2100-hlg';
  if (!hdr && fallbackHex !== undefined) throw new Error('fallbackHex is only for Rec. 2100 PQ or HLG.');
  const copyHex = hdr ? hexCode(fallbackHex, 'HDR fallbackHex') : rgb8Hex(srgb8(toSrgb(normalized, space)));
  if (space === 'srgb' && bitDepth === 8) return { name, hex: copyHex, hdr };
  const native = { label: `${spaceLabels[space]} · ${bitDepth === undefined ? '0–1' : `${bitDepth}-bit`}`, value: rgb.join(', ') };
  return hdr
    ? { name, hex: copyHex, hdr, hdrImage: hdrSwatchUrl(normalized, space), native }
    : { name, hex: copyHex, hdr, css: `color(${space} ${normalized.join(' ')})`, native };
}

function swatch(id: string, label: string, color: ColorThemeColor, formats: readonly ColorThemeFormat[], slot?: number) {
  let value;
  try {
    value = normalizeColor(color);
  } catch (error) {
    throw new Error(`ColorTheme: ${id}: ${(error as Error).message}`);
  }
  const { name, hex, css, hdr, hdrImage, native } = value;
  const match = matchColorName(hex);
  const rgb8 = hexRgb(hex);
  return {
    id, label: name ?? label, slot, hex, css, hdr, hdrImage, native,
    colorName: { value: match.name, exact: match.exact },
    hexLabel: hdr ? 'SDR hex' : native ? 'sRGB hex' : 'Hex',
    values: formats.map(format => ({ label: formatLabels[format], value: formatValue(format, rgb8) })),
  };
}

export function prepareColorTheme(props: ColorThemeProps) {
  const { scheme, formats = ['rgb'] } = props;
  if (scheme !== undefined && props.palette !== undefined) throw new Error('ColorTheme: use either scheme or palette, not both.');
  const { title = scheme?.name ?? (scheme && 'scheme' in scheme ? scheme.scheme : undefined) } = props;
  if (!Array.isArray(formats) || formats.some(format => !Object.hasOwn(formatLabels, format))) {
    throw new Error('ColorTheme: formats must be an array of rgb, hsl, or oklch.');
  }
  const uniqueFormats = [...new Set(formats)];
  const palette = scheme
    ? scheme.palette ?? Object.fromEntries(Object.entries(scheme).filter(([key]) => baseSlot.test(key)))
    : props.palette;
  if (!palette || typeof palette !== 'object' || Array.isArray(palette) || !Object.keys(palette).length) {
    throw new Error('ColorTheme: provide a nonempty palette or Base16/Base24 scheme.');
  }
  const entries = Object.entries(palette);
  let system = scheme?.system ?? props.system;
  if (system === undefined && (scheme || entries.every(([id]) => baseSlot.test(id)))) {
    system = entries.some(([id]) => /^base1[0-9a-f]$/i.test(id)) ? 'base24' : 'base16';
  }
  if (system === undefined) {
    return { title, system, groups: [{ label: undefined, colors: entries.map(([id, color]) => swatch(id, id, color, uniqueFormats)) }] };
  }
  if (system !== 'base16' && system !== 'base24') throw new Error(`ColorTheme: unsupported system "${system}".`);
  const seen = new Set<number>();
  const colors = entries.map(([id, color]) => {
    const match = baseSlot.exec(id);
    const slot = match ? parseInt(match[1], 16) : NaN;
    if (!Number.isInteger(slot) || slot >= (system === 'base16' ? 16 : 24)) {
      throw new Error(`ColorTheme: "${id}" is not a ${system} slot.`);
    }
    const canonicalId = `base${match![1].toUpperCase()}`;
    if (seen.has(slot)) throw new Error(`ColorTheme: duplicate slot ${canonicalId}.`);
    seen.add(slot);
    return swatch(canonicalId, slots[slot], color, uniqueFormats, slot);
  }).sort((a, b) => a.slot! - b.slot!);
  const groups = groupLabels.map((label, index) => ({
    label,
    colors: colors.filter(color => Math.floor(color.slot! / 8) === index),
  })).filter(group => group.colors.length);
  return { title, system, groups };
}
