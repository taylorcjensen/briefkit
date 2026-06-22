const EXPANSIVE_HEADER_PATTERN = /\b(assessment|caveat|details|evaluation|evidence|impact|mitigation|notes?|rationale|reason|recommendation|source|summary|warning|why)\b/i;
const COMPACT_HEADER_PATTERN = /\b(count|date|gb|headroom|plugins?|score|size|slots?|status|version)\b/i;
const TINY_HEADER_PATTERN = /^(sup|joj|ll2|hoh|yes|no)$/i;
const NUMBER_PATTERN = /^\s*[\d.,/%–—+-]+\s*$/;

export function calculateTableWidths(headers: string[], rows: string[][] = []): number[] {
  const columnCount = headers.length;
  const scores = headers.map((header, index) => scoreColumn(header, rows.map((row) => row[index] ?? ''), index, columnCount));
  const total = scores.reduce((sum, value) => sum + value, 0);
  const raw = scores.map((value) => (value / total) * 100);
  const clamped = raw.map((width, index) => clamp(width, minWidthForColumn(headers[index], rows, index), maxWidthForColumn(headers[index], rows, index)));
  return normalizePercentages(redistribute(headers, rows, clamped));
}

function scoreColumn(header: string, cells: string[], index: number, columnCount: number): number {
  const headerScore = textCost(header) * 1.15;
  const cellCosts = cells.map(textCost).sort((a, b) => a - b);
  const p75 = cellCosts[Math.floor(cellCosts.length * 0.75)] ?? 0;
  const max = cellCosts[cellCosts.length - 1] ?? 0;
  let score = Math.max(headerScore, p75 * 1.25, max * 0.55, 8);

  if (isCompactColumn(header, cells)) score *= 0.36;
  if (EXPANSIVE_HEADER_PATTERN.test(header)) score *= 1.45;
  if (index === 0) score *= columnCount >= 8 ? 1.0 : 1.04;
  if (index === columnCount - 1) score *= 1.25;

  return Math.max(4, score);
}

function textCost(value: string): number {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const longestWord = Math.max(...words.map((word) => word.length));
  return Math.sqrt(value.length) * 4 + longestWord * 1.4 + words.length * 0.8;
}

function isCompactColumn(header: string, cells: string[]): boolean {
  const filled = cells.map((cell) => cell.trim()).filter(Boolean);
  if (filled.length === 0) return TINY_HEADER_PATTERN.test(header) || COMPACT_HEADER_PATTERN.test(header);
  const compactCells = filled.filter((cell) => NUMBER_PATTERN.test(cell) || cell.length <= 4).length;
  return (TINY_HEADER_PATTERN.test(header) || COMPACT_HEADER_PATTERN.test(header)) && compactCells / filled.length >= 0.8;
}

function minWidthForColumn(header: string, rows: string[][], index: number): number {
  const cells = rows.map((row) => row[index] ?? '');
  if (isCompactColumn(header, cells)) return 4.5;
  const hasLongTokens = [header, ...cells].some((value) => value.split(/\s+/).some((word) => word.length > 14));
  return hasLongTokens ? 9 : 7;
}

function maxWidthForColumn(header: string, rows: string[][], index: number): number {
  const cells = rows.map((row) => row[index] ?? '');
  if (isCompactColumn(header, cells)) return 8;
  if (index === 0) return 18;
  if (EXPANSIVE_HEADER_PATTERN.test(header)) return 46;
  return 38;
}

function redistribute(headers: string[], rows: string[][], widths: number[]): number[] {
  const result = [...widths];
  let total = result.reduce((sum, width) => sum + width, 0);

  if (total > 100) {
    shrinkToFit(headers, rows, result, total - 100);
    return result;
  }

  const lastIndex = headers.length - 1;
  const firstColumnCap = maxWidthForColumn(headers[0], rows, 0);
  if (result[0] > firstColumnCap) result[0] = firstColumnCap;

  const expandable = headers.map((header, index) => ({
    index,
    weight: isCompactColumn(header, rows.map((row) => row[index] ?? '')) || index === 0
      ? 0
      : index === lastIndex
        ? scoreColumn(header, rows.map((row) => row[index] ?? ''), index, headers.length) * 2
        : scoreColumn(header, rows.map((row) => row[index] ?? ''), index, headers.length),
  })).filter((entry) => entry.weight > 0);

  total = result.reduce((sum, width) => sum + width, 0);
  const weightTotal = expandable.reduce((sum, entry) => sum + entry.weight, 0) || 1;
  const remainder = 100 - total;
  for (const entry of expandable) result[entry.index] += remainder * (entry.weight / weightTotal);
  return result;
}

function shrinkToFit(headers: string[], rows: string[][], widths: number[], excess: number): void {
  const shrinkable = headers.map((header, index) => ({
    index,
    min: minWidthForColumn(header, rows, index),
    room: Math.max(0, widths[index] - minWidthForColumn(header, rows, index)),
  })).filter((entry) => entry.room > 0);
  const roomTotal = shrinkable.reduce((sum, entry) => sum + entry.room, 0) || 1;
  for (const entry of shrinkable) widths[entry.index] -= excess * (entry.room / roomTotal);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizePercentages(widths: number[]): number[] {
  const total = widths.reduce((sum, width) => sum + width, 0);
  const normalized = widths.map((width) => Math.round((width / total) * 1000) / 10);
  const drift = Math.round((100 - normalized.reduce((sum, width) => sum + width, 0)) * 10) / 10;
  normalized[normalized.length - 1] = Math.round((normalized[normalized.length - 1] + drift) * 10) / 10;
  return normalized;
}
