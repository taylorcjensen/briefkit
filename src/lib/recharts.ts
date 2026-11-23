import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import YAML from 'yaml';

/** Compile fenced React modules into islands without passing compound Recharts children through Astro's MDX renderer. */
export async function extractRecharts(source: string, processedPath: string): Promise<string> {
  let index = 0;
  const imports: string[] = [];
  const replacements: Array<{ start: number; end: number; value: string; file: string; code: string }> = [];
  const fence = /^ {0,3}(`{3,}|~{3,})recharts[ \t]*\r?\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm;
  for (const match of source.matchAll(fence)) {
    const name = `BriefkitRecharts${index++}`;
    const file = `${processedPath.slice(0, -path.extname(processedPath).length)}.recharts-${index}.jsx`;
    if (!/\bexport\s+default\b/.test(match[2])) {
      throw new Error(`Recharts block ${index} needs an exported default React component (export default function Chart() { ... }).`);
    }
    imports.push(`import ${name} from ${JSON.stringify(`./${path.basename(file)}`)};`);
    replacements.push({ start: match.index!, end: match.index! + match[0].length, value: `<${name} client:only="react" />`, file, code: match[2] });
  }
  if (replacements.length === 0) return source;
  await Promise.all(replacements.map(async ({ file, code }) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, code, 'utf8');
  }));
  let output = source;
  for (const replacement of replacements.reverse()) {
    output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
  }
  return `${imports.join('\n')}\n\n${output}`;
}

/** Vite plugin: import rows from a source file, select columns, then embed only that projection in the JS bundle. */
export function rechartsDataPlugin() {
  return {
    name: 'briefkit-recharts-data',
    enforce: 'pre' as const,
    transform(source: string, id: string) {
      const [file, query] = id.split('?', 2);
      if (!query || !/\.(csv|json|ya?ml)$/i.test(file)) return null;
      const params = new URLSearchParams(query);
      if (!params.has('pick')) return null;
      const fields = params.get('pick')?.split(',').map((field) => field.trim());
      if (!fields?.length || fields.some((field) => !field) || new Set(fields).size !== fields.length) {
        throw new Error(`Invalid ?pick= field list in ${file}`);
      }
      const ext = path.extname(file).toLowerCase();
      const parsed: unknown = ext === '.csv'
        ? parseCsv(source, { columns: true, skip_empty_lines: true, bom: true, cast: true })
        : ext === '.json' ? JSON.parse(source) : YAML.parse(source);
      if (!Array.isArray(parsed)) throw new Error(`${file}: selected chart data must be an array of records.`);
      const rows = parsed.map((row: unknown, index: number) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${file}: row ${index + 1} is not a record.`);
        return Object.fromEntries(fields.map((field) => {
          if (!Object.hasOwn(row, field)) throw new Error(`${file}: missing field ${field} in row ${index + 1}.`);
          return [field, (row as Record<string, unknown>)[field]];
        }));
      });
      return { code: `export default ${JSON.stringify(rows)};`, map: null };
    },
  };
}
