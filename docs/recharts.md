# Recharts in MDX

Use a `recharts` fence in a report `.mdx` page to write a **normal React module**. Export a default component and use any Recharts chart, props, child components, custom React components or data transformations you need. Briefkit extracts each fence as a React island; it does not translate a chart schema. The chart runs in the browser, with React and Recharts bundled into local Astro assets. No chart-data request is made at runtime. JavaScript must be enabled to see the chart.

`index.mdx`:

````mdx
---
title: Quarterly revenue
---

## Revenue and cost

```recharts
import { ComposedChart, Bar, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import rows from '@report/data/quarterly.csv?pick=quarter,revenue,cost';

const forecast = [{ quarter: 'Q4', revenue: 24, cost: 11 }];
const RevenueLine = () => <Line type="monotone" dataKey="revenue" stroke="#2563eb" />;

export default function QuarterlyChart() {
  return <ComposedChart width={620} height={320} data={[...rows, ...forecast]} accessibilityLayer>
    <CartesianGrid strokeDasharray="3 3" />
    <XAxis dataKey="quarter" /><YAxis /><Tooltip /><Legend />
    <Bar dataKey="cost" fill="#f97316" />
    <RevenueLine />
  </ComposedChart>;
}
```
````

`data/quarterly.csv`:

```csv
quarter,revenue,cost,internalNotes
Q1,12,7,do not publish
Q2,18,8,do not publish
Q3,20,9,do not publish
```

Run `briefkit build . --out ./brief` (or `briefkit dev .`). Only `quarter`, `revenue`, and `cost` from this CSV are included in the browser bundle. The source data directory is not copied to the output. **Do not import a sensitive source directly without `?pick=`**: ordinary JavaScript imports are not projected. Do not place sensitive files under `public/`, which is copied verbatim. Check generated assets before distributing sensitive reports.

CSV, JSON, and YAML (`.yaml`/`.yml`) files can be imported with `?pick=field,otherField`; each must contain an array of records (CSV header row and records, JSON array, or YAML sequence). Missing fields are build errors. CSV values are inferred as numbers/booleans when possible; JSON/YAML retain their native types. Inline JavaScript arrays, objects and computed values can also be used without an import. Use `@report/` to locate report files: relative imports inside a chart fence resolve from the generated chart module, not from the original MDX file. Multiple chart fences per page are supported. The React module may import local React components with `@report/components/...`.

Chart dimensions are controlled by native Recharts props. A fixed `width`/`height` is the simplest reliable choice; if using `ResponsiveContainer`, give its parent a measurable height. Since chart islands use `client:only="react"`, the static HTML contains an island placeholder rather than prerendered SVG. Keep a textual summary or table alongside charts for readers without JavaScript and for accessible report review.
