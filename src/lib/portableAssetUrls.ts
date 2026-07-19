import fs from 'node:fs/promises';
import path from 'node:path';
import * as parse5 from 'parse5';
import postcss, { CssSyntaxError } from 'postcss';
import valueParser from 'postcss-value-parser';

type Document = parse5.DefaultTreeAdapterMap['document'];
type DocumentFragment = parse5.DefaultTreeAdapterMap['documentFragment'];
type Element = parse5.DefaultTreeAdapterMap['element'];
type ChildNode = parse5.DefaultTreeAdapterMap['childNode'];

type HtmlRoot = Document | DocumentFragment;
type UrlKind = 'report-root' | 'external-or-special' | 'relative';

interface RewriteResult {
  value: string;
  changed: boolean;
}

const URL_ATTRIBUTES = new Set([
  'action',
  'archive',
  'background',
  'cite',
  'codebase',
  'data',
  'formaction',
  'href',
  'icon',
  'longdesc',
  'manifest',
  'poster',
  'profile',
  'src',
  'xlink:href',
]);

const SRCSET_ATTRIBUTES = new Set(['srcset', 'imagesrcset']);
const RAW_TEXT_TAGS = new Set(['style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
const SPECIAL_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const FULL_HTML_DOCUMENT_PATTERN = /^\s*(?:<!doctype\s+html\b[^>]*>\s*)?<html(?:\s|>)/i;

export async function normalizePortableAssetUrls(outDir: string): Promise<void> {
  await normalizeFilesInDirectory(outDir, outDir);
}

export function classifyUrlReference(value: string): UrlKind {
  const trimmed = value.trimStart();
  if (!trimmed || trimmed.startsWith('#')) return 'external-or-special';
  if (trimmed.startsWith('//') || SPECIAL_URL_PATTERN.test(trimmed)) return 'external-or-special';
  return trimmed.startsWith('/') ? 'report-root' : 'relative';
}

export function rewriteReportRootUrl(value: string, relativePrefix: string): string {
  if (classifyUrlReference(value) !== 'report-root') return value;
  const leadingWhitespace = value.match(/^\s*/)?.[0] ?? '';
  const trimmed = value.slice(leadingWhitespace.length);
  return `${leadingWhitespace}${relativePrefix}${trimmed.slice(1)}`;
}

export function rewriteSrcset(value: string, relativePrefix: string): string {
  let index = 0;
  let rewritten = '';

  while (index < value.length) {
    const leadingStart = index;
    index = consumeSpaces(value, index);
    rewritten += value.slice(leadingStart, index);

    const urlStart = index;
    index = consumeSrcsetUrl(value, index);
    if (urlStart === index) {
      rewritten += value.slice(index);
      break;
    }

    rewritten += rewriteReportRootUrl(value.slice(urlStart, index), relativePrefix);

    const descriptorStart = index;
    index = consumeSrcsetDescriptors(value, index);
    rewritten += value.slice(descriptorStart, index);

    if (value[index] === ',') {
      rewritten += value[index];
      index += 1;
    }
  }

  return rewritten;
}

export function rewriteCssRootUrls(css: string, relativePrefix: string): string {
  return rewriteCssRootUrlsSafely(css, relativePrefix).value;
}

async function normalizeFilesInDirectory(rootDir: string, currentDir: string): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await normalizeFilesInDirectory(rootDir, filePath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.toLowerCase().endsWith('.html')) {
      await normalizeHtmlFile(rootDir, filePath);
    } else if (entry.name.toLowerCase().endsWith('.css')) {
      await normalizeCssFile(rootDir, filePath);
    }
  }
}

async function normalizeHtmlFile(rootDir: string, filePath: string): Promise<void> {
  const relativePrefix = relativePrefixForFile(rootDir, filePath);
  const source = await fs.readFile(filePath, 'utf8');
  const isDocument = isFullHtmlDocument(source);
  const root = parseHtml(source, isDocument);
  const changed = rewriteHtmlNodeUrls(root, relativePrefix, filePath);
  if (changed) await fs.writeFile(filePath, serializeHtml(root, isDocument), 'utf8');
}

async function normalizeCssFile(rootDir: string, filePath: string): Promise<void> {
  const relativePrefix = relativePrefixForFile(rootDir, filePath);
  const source = await fs.readFile(filePath, 'utf8');
  const result = rewriteCssRootUrlsSafely(source, relativePrefix, filePath);
  if (result.changed) await fs.writeFile(filePath, result.value, 'utf8');
}

function relativePrefixForFile(rootDir: string, filePath: string): string {
  const relativeDirectory = path.relative(rootDir, path.dirname(filePath));
  if (!relativeDirectory) return './';
  const depth = relativeDirectory.split(path.sep).filter(Boolean).length;
  return '../'.repeat(depth);
}

function isFullHtmlDocument(source: string): boolean {
  return FULL_HTML_DOCUMENT_PATTERN.test(source);
}

function parseHtml(source: string, isDocument: boolean): HtmlRoot {
  return isDocument ? parse5.parse(source, { sourceCodeLocationInfo: false }) : parse5.parseFragment(source, { sourceCodeLocationInfo: false });
}

function serializeHtml(root: HtmlRoot, isDocument: boolean): string {
  return isDocument ? parse5.serialize(root as Document) : parse5.serialize((root as DocumentFragment));
}

function rewriteHtmlNodeUrls(node: HtmlRoot | ChildNode, relativePrefix: string, filePath?: string): boolean {
  let changed = isElement(node) ? rewriteElementUrls(node, relativePrefix, filePath) : false;
  for (const child of getChildNodes(node)) changed = rewriteHtmlNodeUrls(child, relativePrefix, filePath) || changed;
  return changed;
}

function rewriteElementUrls(element: Element, relativePrefix: string, filePath?: string): boolean {
  let changed = false;
  for (const attribute of element.attrs) {
    const attributeName = attribute.name.toLowerCase();
    if (URL_ATTRIBUTES.has(attributeName)) {
      changed = rewriteAttributeValue(attribute, rewriteReportRootUrl(attribute.value, relativePrefix)) || changed;
    } else if (SRCSET_ATTRIBUTES.has(attributeName)) {
      changed = rewriteAttributeValue(attribute, rewriteSrcset(attribute.value, relativePrefix)) || changed;
    } else if (attributeName === 'style') {
      const result = rewriteStyleAttributeSafely(attribute.value, relativePrefix, filePath);
      changed = rewriteAttributeValue(attribute, result.value) || changed;
    }
  }

  if (element.tagName === 'style') changed = rewriteStyleElement(element, relativePrefix, filePath) || changed;
  return changed;
}

function rewriteAttributeValue(attribute: parse5.Token.Attribute, nextValue: string): boolean {
  if (attribute.value === nextValue) return false;
  attribute.value = nextValue;
  return true;
}

function rewriteStyleAttributeSafely(value: string, relativePrefix: string, filePath?: string): RewriteResult {
  return catchCssSyntaxError(() => rewriteStyleAttribute(value, relativePrefix), value, cssWarningContext(filePath, 'style attribute'));
}

function rewriteStyleAttribute(value: string, relativePrefix: string): RewriteResult {
  const root = postcss.parse(`a{${value}}`);
  let changed = false;
  root.walkDecls((declaration) => {
    const result = rewriteCssValueWithChange(declaration.value, relativePrefix);
    if (result.changed) {
      declaration.value = result.value;
      changed = true;
    }
  });
  const rule = root.first;
  if (!changed || rule?.type !== 'rule') return { value, changed: false };
  return { value: rule.nodes.map((node) => node.toString()).join(';'), changed: true };
}

function rewriteStyleElement(element: Element, relativePrefix: string, filePath?: string): boolean {
  let changed = false;
  for (const child of getChildNodes(element)) {
    if ('value' in child && typeof child.value === 'string') {
      const result = rewriteCssRootUrlsSafely(child.value, relativePrefix, cssWarningContext(filePath, '<style>'));
      if (result.changed) {
        child.value = result.value;
        changed = true;
      }
    }
  }
  return changed;
}

function rewriteCssRootUrlsSafely(css: string, relativePrefix: string, warningContext?: string): RewriteResult {
  return catchCssSyntaxError(() => rewriteCssRootUrlsWithChange(css, relativePrefix), css, warningContext);
}

function rewriteCssRootUrlsWithChange(css: string, relativePrefix: string): RewriteResult {
  const root = postcss.parse(css);
  let changed = false;
  root.walkDecls((declaration) => {
    const result = rewriteCssValueWithChange(declaration.value, relativePrefix);
    if (result.changed) {
      declaration.value = result.value;
      changed = true;
    }
  });
  root.walkAtRules('import', (rule) => {
    const result = rewriteImportParamsWithChange(rule.params, relativePrefix);
    if (result.changed) {
      rule.params = result.value;
      changed = true;
    }
  });
  return { value: changed ? root.toString() : css, changed };
}

function rewriteImportParamsWithChange(params: string, relativePrefix: string): RewriteResult {
  const parsed = valueParser(params);
  const firstNode = parsed.nodes.find((node) => node.type !== 'space' && node.type !== 'comment');
  let changed = false;
  if (firstNode?.type === 'string') {
    changed = rewriteParsedUrlNode(firstNode, relativePrefix);
  } else if (firstNode?.type === 'function' && firstNode.value.toLowerCase() === 'url') {
    changed = rewriteUrlFunction(firstNode, relativePrefix);
  }
  return { value: changed ? parsed.toString() : params, changed };
}

function rewriteCssValueWithChange(value: string, relativePrefix: string): RewriteResult {
  const parsed = valueParser(value);
  let changed = false;
  parsed.walk((node) => {
    if (node.type === 'function' && node.value.toLowerCase() === 'url') {
      changed = rewriteUrlFunction(node, relativePrefix) || changed;
    }
  });
  return { value: changed ? parsed.toString() : value, changed };
}

function rewriteUrlFunction(node: valueParser.FunctionNode, relativePrefix: string): boolean {
  const urlNode = node.nodes.find((child) => child.type !== 'space' && child.type !== 'comment');
  if (!urlNode) return false;
  if (urlNode.type === 'string' || urlNode.type === 'word') return rewriteParsedUrlNode(urlNode, relativePrefix);
  return false;
}

function rewriteParsedUrlNode(node: valueParser.StringNode | valueParser.WordNode, relativePrefix: string): boolean {
  const nextValue = rewriteReportRootUrl(node.value, relativePrefix);
  if (node.value === nextValue) return false;
  node.value = nextValue;
  return true;
}

function catchCssSyntaxError(action: () => RewriteResult, originalValue: string, warningContext?: string): RewriteResult {
  try {
    return action();
  } catch (error) {
    if (!(error instanceof CssSyntaxError)) throw error;
    warnCssSkipped(error, warningContext);
    return { value: originalValue, changed: false };
  }
}

function warnCssSkipped(error: CssSyntaxError, warningContext?: string): void {
  const location = error.line && error.column ? ` at ${error.line}:${error.column}` : '';
  const context = warningContext ? ` in ${warningContext}` : '';
  console.warn(`Briefkit warning: skipped portable asset URL rewriting for malformed CSS${context}${location}: ${error.reason}`);
}

function cssWarningContext(filePath: string | undefined, location: string): string | undefined {
  return filePath ? `${filePath} ${location}` : location;
}

function consumeSrcsetUrl(value: string, start: number): number {
  const isDataUrl = value.slice(start, start + 5).toLowerCase() === 'data:';
  let index = start;
  while (index < value.length) {
    const character = value[index];
    if (isHtmlSpace(character)) break;
    if (!isDataUrl && character === ',') break;
    index += 1;
  }
  return index;
}

function consumeSrcsetDescriptors(value: string, start: number): number {
  let index = start;
  while (index < value.length && value[index] !== ',') index += 1;
  return index;
}

function consumeSpaces(value: string, start: number): number {
  let index = start;
  while (index < value.length && isHtmlSpace(value[index])) index += 1;
  return index;
}

function isHtmlSpace(value: string): boolean {
  return value === ' ' || value === '\n' || value === '\t' || value === '\f' || value === '\r';
}

function isElement(node: HtmlRoot | ChildNode): node is Element {
  return 'tagName' in node && 'attrs' in node;
}

function getChildNodes(node: HtmlRoot | ChildNode): ChildNode[] {
  if ('childNodes' in node) return node.childNodes;
  if (isElement(node) && RAW_TEXT_TAGS.has(node.tagName)) return node.childNodes;
  return [];
}
