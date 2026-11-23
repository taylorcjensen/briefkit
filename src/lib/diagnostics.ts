import fs from 'node:fs/promises';
import path from 'node:path';
import type { PageInfo, ReportInfo } from './types.js';

export interface Diagnostic {
  file: string;
  line: number;
  message: string;
}

/** Source-only checks: no network requests, compilation, or generated output. */
export async function checkReport(report: ReportInfo): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const sources = new Map<PageInfo, string[]>();
  const anchors = new Map<PageInfo, Set<string>>();
  for (const page of report.pages) {
    const lines = visibleLines(await fs.readFile(page.absolutePath, 'utf8'));
    sources.set(page, lines);
    anchors.set(page, collectAnchors(lines));
  }
  const routes = new Map(report.pages.map((page) => [page.route, page]));
  const files = new Map(report.pages.map((page) => [page.file, page]));
  const exists = async (file: string): Promise<boolean> => {
    try { await fs.access(file); return true; } catch { return false; }
  };

  for (const page of report.pages) {
    const lines = sources.get(page)!;
    const footnotes = new Set<string>();
    for (const line of lines) {
      for (const match of line.matchAll(/^\s*\[\^([^\]]+)\]:/g)) footnotes.add(match[1]);
    }
    for (const [index, raw] of lines.entries()) {
      // Inline code and MDX expressions are not prose or link targets.
      const line = raw.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, '').replace(/\{[^{}]*\}/g, '');
      const warn = (message: string) => diagnostics.push({ file: page.file, line: index + 1, message });
      for (const match of line.matchAll(/\[\^([^\]]+)\](?!:)/g)) {
        if (!footnotes.has(match[1])) warn(`Undefined footnote [^${match[1]}].`);
      }
      // Restrict placeholders to explicit editorial tokens, not ordinary prose such as “to do”.
      for (const match of line.matchAll(/\b(?:TODO|TBD|FIXME)\b|\[(?:INSERT|PLACEHOLDER|TODO|TBD)(?:[^\]\n]*)\]/gi)) {
        warn(`Placeholder ${match[0]} remains.`);
      }
      // @report/data imports identify local data even when the source is MDX rather than a link.
      for (const match of line.matchAll(/\bfrom\s+['"]@report\/(data\/[^'"]+)['"]/g)) {
        if (!await exists(path.join(report.reportDir, match[1]))) warn(`Missing referenced data: ${match[1]}.`);
      }
      const targets: { value: string; image: boolean }[] = [];
      for (const match of line.matchAll(/(!?)\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+['"][^'"]*['"])?\s*\)/g)) {
        targets.push({ value: match[2], image: match[1] === '!' });
      }
      for (const match of line.matchAll(/<(a|img)\b[^>]*\b(?:href|src)\s*=\s*['"]([^'"]+)['"][^>]*>/gi)) {
        targets.push({ value: match[2], image: match[1].toLowerCase() === 'img' });
      }
      for (const { value, image } of targets) {
        const target = value.replace(/^<|>$/g, '').replace(/&amp;/g, '&');
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target) || /[{}]/.test(target)) continue;
        const [pathname, hash = ''] = target.split('#', 2);
        const cleanPath = pathname.split('?')[0];
        if (!cleanPath && !hash) continue;
        let decoded: string;
        try { decoded = decodeURIComponent(cleanPath); } catch { continue; }
        let targetPage: PageInfo | undefined;
        if (!decoded) targetPage = page;
        else if (!image) {
          const sourceRelative = path.posix.normalize(path.posix.join(path.posix.dirname(page.file), decoded));
          targetPage = files.get(sourceRelative);
          if (!targetPage) {
            const route = path.posix.normalize(path.posix.join(page.route, decoded));
            targetPage = routes.get(route === '/' ? '/' : `/${route.replace(/^\/+|\/+$/g, '')}/`);
          }
        }
        if (targetPage) {
          if (hash) {
            let id: string;
            try { id = decodeURIComponent(hash); } catch { continue; }
            if (!anchors.get(targetPage)?.has(id)) warn(`Missing anchor #${id} in ${targetPage.file}.`);
          }
          continue;
        }
        if (!decoded) { if (hash) warn(`Missing anchor #${hash} in ${page.file}.`); continue; }
        if (/^(?:mailto:|tel:)/i.test(decoded)) continue;
        // Absolute URLs refer to site routes or public/ assets; relative assets may live beside the source or in public/.
        const publicPath = path.resolve(report.reportDir, 'public', decoded.replace(/^\/+/, ''));
        const localPath = path.resolve(path.dirname(page.absolutePath), decoded.replace(/^\/+/, ''));
        const within = (p: string) => p.startsWith(`${report.reportDir}${path.sep}`);
        if ((within(localPath) && await exists(localPath)) || (within(publicPath) && await exists(publicPath))) continue;
        // Do not infer missing assets for unknown extensionless routes unless they are explicit relative files.
        const isFile = image || /\.[a-z\d]+$/i.test(decoded);
        warn(`${isFile ? 'Missing local asset or page' : 'Broken local link'}: ${target}.`);
      }
    }
    if (page.image && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(page.image)) {
      const image = page.image.split(/[?#]/)[0].replace(/^\/+/, '');
      if (image && !await exists(path.join(report.reportDir, 'public', image)) && !await exists(path.resolve(path.dirname(page.absolutePath), image))) {
        // If this image occurs in body markup, the link check has already reported it.
        if (!lines.some((line) => line.includes(page.image!))) diagnostics.push({ file: page.file, line: 1, message: `Missing referenced image: ${page.image}.` });
      }
    }
  }
  return diagnostics;
}

function visibleLines(source: string): string[] {
  const lines = source.split(/\r?\n/);
  let fence: { char: string; size: number } | undefined;
  let frontmatter = lines[0]?.trim() === '---';
  return lines.map((line, index) => {
    if (frontmatter) {
      if (index > 0 && line.trim() === '---') frontmatter = false;
      return '';
    }
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      if (!fence) fence = { char: match[1][0], size: match[1].length };
      else if (match[1][0] === fence.char && match[1].length >= fence.size) fence = undefined;
      return '';
    }
    if (fence || /^(?: {4}|\t)/.test(line)) return '';
    return line;
  });
}

function collectAnchors(lines: string[]): Set<string> {
  const anchors = new Set<string>();
  const used = new Map<string, number>();
  for (const line of lines) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const text = heading[1].replace(/<[^>]+>/g, '').replace(/!??\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '');
      const slug = text.toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');
      const count = used.get(slug) ?? 0;
      used.set(slug, count + 1);
      anchors.add(count ? `${slug}-${count}` : slug);
    }
    for (const match of line.matchAll(/\bid\s*=\s*['"]([^'"]+)['"]/g)) anchors.add(match[1]);
  }
  return anchors;
}

export function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) console.warn(`Briefkit warning: ${diagnostic.file}:${diagnostic.line}: ${diagnostic.message}`);
  console.log(`Briefkit check: ${diagnostics.length} warning${diagnostics.length === 1 ? '' : 's'}`);
}
