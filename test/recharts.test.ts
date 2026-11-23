import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { makeTempDir, runBriefkit } from './helpers/process.ts';
import { extractRecharts, rechartsDataPlugin } from '../src/lib/recharts.ts';

const plugin = rechartsDataPlugin();

test('selected CSV, JSON and YAML fields are projected before embedding', () => {
  const sources = [
    ['sales.csv?pick=month,revenue', 'month,revenue,private\nJan,12,SECRET-CSV\n'],
    ['sales.json?pick=month,revenue', '[{"month":"Jan","revenue":12,"private":"SECRET-JSON"}]'],
    ['sales.yaml?pick=month,revenue', '- month: Jan\n  revenue: 12\n  private: SECRET-YAML\n'],
  ];
  for (const [file, source] of sources) {
    const result = plugin.transform(source, `/report/data/${file}`);
    assert(result);
    assert.deepEqual(JSON.parse(result.code.slice('export default '.length, -1)), [{ month: 'Jan', revenue: 12 }]);
    assert.doesNotMatch(result.code, /private|SECRET/);
  }
  assert.throws(() => plugin.transform('[{"month":"Jan"}]', '/report/data/sales.json?pick=revenue'), /missing field revenue/);
});

test('Recharts fences become separate React modules and regular fenced examples stay literal', async () => {
  const dir = await makeTempDir('recharts-extract');
  const processed = path.join(dir, 'index.mdx');
  const output = await extractRecharts('```mdx\n<BarChart />\n```\n\n```recharts\nexport default function Chart() { return <BarChart />; }\n```', processed);
  assert.match(output, /import BriefkitRecharts0 from "\.\/index\.recharts-1\.jsx";/);
  assert.match(output, /<BriefkitRecharts0 client:only="react" \/>/);
  assert.match(output, /```mdx\n<BarChart \/>\n```/);
  assert.match(await fs.readFile(path.join(dir, 'index.recharts-1.jsx'), 'utf8'), /export default function Chart/);
});

test('CLI builds MDX Recharts islands with inline and projected external data and local browser bundles', { timeout: 120_000 }, async () => {
  const dir = await makeTempDir('recharts-build');
  const report = path.join(dir, 'report');
  const dataDir = path.join(report, 'data');
  const out = path.join(dir, 'dist');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'sales.csv'), 'month,revenue,cost,private\nJan,12,7,SECRET-CSV\nFeb,18,8,SECRET-CSV\n');
  await fs.writeFile(path.join(dataDir, 'sales.json'), '[{"month":"Jan","revenue":12,"private":"SECRET-JSON"}]');
  await fs.writeFile(path.join(dataDir, 'sales.yaml'), '- month: Jan\n  revenue: 12\n  private: SECRET-YAML\n');
  await fs.writeFile(path.join(report, 'index.mdx'), `---
title: Sales chart
---
## Revenue

\`\`\`recharts
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import sales from '@report/data/sales.csv?pick=month,revenue,cost';
import jsonSales from '@report/data/sales.json?pick=month,revenue';
import yamlSales from '@report/data/sales.yaml?pick=month,revenue';
const inline = [{ month: 'Mar', revenue: 20, cost: 9 }];
export default function SalesChart() {
  return <BarChart width={520} height={270} data={[...sales, ...jsonSales, ...yamlSales, ...inline]} accessibilityLayer>
    <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="month" /><YAxis />
    <Tooltip /><Legend /><Bar dataKey="revenue" fill="#2563eb" /><Bar dataKey="cost" fill="#f97316" />
  </BarChart>;
}
\`\`\`
`);
  const result = await runBriefkit(['build', report, '--out', out]);
  assert.equal(result.exitCode, 0, result.stderr);
  const html = await fs.readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /<astro-island[^>]*client="only"/);
  assert.match(html, /Revenue/);
  assert.doesNotMatch(html, /SECRET-CSV|SECRET-JSON|SECRET-YAML/);
  await assert.rejects(fs.access(path.join(out, 'data', 'sales.csv')));
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)="https?:\/\//);
  const assets = path.join(out, '_astro');
  const bundle = (await Promise.all((await fs.readdir(assets)).filter((entry) => /\.(js|mjs)$/.test(entry)).map((entry) => fs.readFile(path.join(assets, entry), 'utf8')))).join('\n');
  assert.match(bundle, /Jan/);
  assert.match(bundle, /Mar/);
  assert.doesNotMatch(bundle, /SECRET-CSV|SECRET-JSON|SECRET-YAML|"private"/);
});
