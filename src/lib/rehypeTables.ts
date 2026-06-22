import { calculateTableWidths } from './tableWidths.js';

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export default function briefkitTables() {
  return (tree: HastNode) => {
    visit(tree, (node) => {
      if (node.type === 'element' && node.tagName === 'table') normalizeTable(node);
    });
  };
}

function normalizeTable(table: HastNode): void {
  const headers = getHeaderTexts(table);
  if (headers.length === 0) return;

  addClass(table, 'bk-normalized-table');
  removeExistingColgroup(table);
  table.children = [createColgroup(headers, getBodyRows(table)), ...(table.children ?? [])];
}

function getHeaderTexts(table: HastNode): string[] {
  const headerRow = findFirst(table, (node) => node.tagName === 'thead')
    ?.children?.find((node) => node.tagName === 'tr')
    ?? findFirst(table, (node) => node.tagName === 'tr');

  return (headerRow?.children ?? [])
    .filter((node) => node.tagName === 'th' || node.tagName === 'td')
    .map(textContent);
}

function getBodyRows(table: HastNode): string[][] {
  const body = findFirst(table, (node) => node.tagName === 'tbody') ?? table;
  return (body.children ?? [])
    .filter((node) => node.tagName === 'tr')
    .map((row) => (row.children ?? [])
      .filter((cell) => cell.tagName === 'th' || cell.tagName === 'td')
      .map(textContent));
}

function createColgroup(headers: string[], rows: string[][]): HastNode {
  return {
    type: 'element',
    tagName: 'colgroup',
    properties: {},
    children: calculateTableWidths(headers, rows).map((width) => ({
      type: 'element',
      tagName: 'col',
      properties: { style: `width: ${width}%` },
      children: [],
    })),
  };
}

function removeExistingColgroup(table: HastNode): void {
  table.children = (table.children ?? []).filter((child) => child.tagName !== 'colgroup');
}

function addClass(node: HastNode, className: string): void {
  node.properties ??= {};
  const current = node.properties.className;
  if (Array.isArray(current)) {
    if (!current.includes(className)) current.push(className);
    return;
  }
  if (typeof current === 'string') {
    node.properties.className = current.includes(className) ? current : `${current} ${className}`;
    return;
  }
  node.properties.className = [className];
}

function findFirst(node: HastNode, predicate: (node: HastNode) => boolean): HastNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function textContent(node: HastNode): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(textContent).join('').trim();
}

function visit(node: HastNode, callback: (node: HastNode) => void): void {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}
