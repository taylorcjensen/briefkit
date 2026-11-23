export type Rgb = readonly [number, number, number];

export function mapRgb([r, g, b]: Rgb, transform: (value: number) => number): Rgb {
  return [transform(r), transform(g), transform(b)];
}

export function hexRgb(hex: string): Rgb {
  const value = parseInt(hex.slice(1), 16);
  return [value >> 16, (value >> 8) & 255, value & 255];
}

export function rgb8Hex(rgb: Rgb): string {
  return '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function srgb8(rgb: Rgb): Rgb {
  return mapRgb(rgb, value => Math.round(Math.min(1, Math.max(0, value)) * 255));
}

function decodeSrgb(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function encodeSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

function transformRgb([r, g, b]: Rgb, [x, y, z]: readonly [Rgb, Rgb, Rgb]): Rgb {
  const dot = ([i, j, k]: Rgb) => i * r + j * g + k * b;
  return [dot(x), dot(y), dot(z)];
}

// D65 matrices and transfer functions from CSS Color 4:
// https://www.w3.org/TR/css-color-4/#color-conversion-code
const p3ToXyz = [
  [608311 / 1250200, 189793 / 714400, 198249 / 1000160],
  [35783 / 156275, 247089 / 357200, 198249 / 2500400],
  [0, 32229 / 714400, 5220557 / 5000800],
] as const;
const rec2020ToXyz = [
  [63426534 / 99577255, 20160776 / 139408157, 47086771 / 278816314],
  [26158966 / 99577255, 472592308 / 697040785, 8267143 / 139408157],
  [0, 19567812 / 697040785, 295819943 / 278816314],
] as const;
const xyzToSrgb = [
  [12831 / 3959, -329 / 214, -1974 / 3959],
  [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
  [705 / 12673, -2585 / 12673, 705 / 667],
] as const;

export function toSrgb(rgb: Rgb, space: 'srgb' | 'srgb-linear' | 'display-p3' | 'rec2020'): Rgb {
  if (space === 'srgb') return rgb;
  if (space === 'srgb-linear') return mapRgb(rgb, encodeSrgb);
  const xyz = space === 'display-p3'
    ? transformRgb(mapRgb(rgb, decodeSrgb), p3ToXyz)
    : transformRgb(mapRgb(rgb, value => value ** 2.4), rec2020ToXyz);
  return mapRgb(transformRgb(xyz, xyzToSrgb), encodeSrgb);
}

// Björn Ottosson's linear sRGB → OKLab matrices, D65.
// https://bottosson.github.io/posts/oklab/
export function oklab(rgb: Rgb): Rgb {
  const lms = transformRgb(mapRgb(rgb, decodeSrgb), [
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
  ]);
  return transformRgb(mapRgb(lms, Math.cbrt), [
    [0.2104542553, 0.7936177850, -0.0040720468],
    [1.9779984951, -2.4285922050, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.8086757660],
  ]);
}

export function hsl([r, g, b]: Rgb): readonly [number | undefined, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const lightness = (max + min) / 2;
  if (chroma === 0) return [undefined, 0, lightness];
  const sector = max === r ? (g - b) / chroma : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  return [(sector * 60 + 360) % 360, chroma / (1 - Math.abs(2 * lightness - 1)), lightness];
}
