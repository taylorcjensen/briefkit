import cssNames from '../data/color-names/css.json';
import allNames from '../data/color-names/colornames.min.json';
import { hexRgb, mapRgb, oklab, type Rgb } from './colorMath.js';

type NameMatch = { name: string; source: 'CSS' | 'Color Name List'; exact: boolean };

const cssByHex = new Map<string, string>();
for (const [name, hex] of Object.entries(cssNames)) {
  const aliases = cssByHex.get(hex);
  cssByHex.set(hex, aliases ? `${aliases} / ${name}` : name);
}
const namesByHex: Readonly<Record<string, string | undefined>> = allNames;

let candidates: (Omit<NameMatch, 'exact'> & { lab: Rgb })[] | undefined;

function labFor(hex: string): Rgb {
  return oklab(mapRgb(hexRgb(`#${hex}`), value => value / 255));
}

export function matchColorName(hex: string): NameMatch {
  const key = hex.slice(1).toLowerCase();
  const cssName = cssByHex.get(key);
  if (cssName) return { name: cssName, source: 'CSS', exact: true };
  const listedName = namesByHex[key];
  if (listedName) return { name: listedName, source: 'Color Name List', exact: true };

  candidates ??= [
    ...Array.from(cssByHex, ([hex, name]) => ({ name, source: 'CSS' as const, lab: labFor(hex) })),
    ...Object.entries(allNames).map(([hex, name]) => ({ name, source: 'Color Name List' as const, lab: labFor(hex) })),
  ];
  const [l, a, b] = labFor(key);
  let closest = candidates[0];
  let distance = Infinity;
  for (const candidate of candidates) {
    const [cl, ca, cb] = candidate.lab;
    const next = (l - cl) ** 2 + (a - ca) ** 2 + (b - cb) ** 2;
    if (next < distance) {
      distance = next;
      closest = candidate;
    }
  }
  return { name: closest.name, source: closest.source, exact: false };
}
