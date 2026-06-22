# Briefkit

Briefkit turns AI research into local, static, decision-oriented report websites.

It is not an agent framework, dashboard backend, or structured-data prison. The goal is simple: preserve nuanced analysis while reusing a consistent report shell, dense table style, sidebar navigation, glossary hover behavior, callouts, and table patterns.

## Status

Briefkit now has an early Astro/MDX CLI prototype:

```bash
npm install
npm run briefkit -- dev examples/basic-report --no-open
npm run briefkit -- build examples/basic-report
```

The intended linked/global workflow is:

```bash
npm link
briefkit dev /path/to/report
briefkit build /path/to/report
```

`dev` is the primary workflow: it starts live reload and opens the browser by default. Agents should not separately open the browser after running `briefkit dev`.

`build` writes static output to:

```text
{report-folder}/brief/
```

## Report folder shape

Minimum Markdown report:

```text
my-report/
  README.md
```

Minimum MDX report:

```text
my-report/
  index.mdx
```

Optional structure:

```text
my-report/
  README.md
  index.mdx
  pages/**/*.{md,mdx}
  components/**/*.{astro,tsx,jsx}
  data/**/*.{json,yaml,yml,csv}
  public/**/*
  briefkit.config.{ts,js,mjs}
```

Root page priority is:

```text
index.mdx > index.md > README.mdx > README.md
```

Example config:

```js
export default {
  title: 'Vendor Decision Brief',
  author: 'Claude',
  pages: [
    'index.mdx',
    { file: 'pages/details.mdx', title: 'Details', route: '/details/' },
  ],
};
```

## Markdown quick start

A plain `README.md` works as a complete Briefkit report:

```md
# Vendor Decision Brief

## Verdict

Pick Option A if you need the lowest maintenance path.

## Comparison

| Option | Best for | Caveat |
|---|---|---|
| A | Fast decisions | Less customizable |
| B | Deep analysis | More work |
```

Run it with:

```bash
briefkit dev /path/to/report
```

Briefkit automatically upgrades ordinary Markdown tables with shared table styling, sticky headers, and content-aware column widths. Use Markdown when portability and speed matter; use MDX when you need Briefkit components, local components, or imported data.

## MDX authoring

```mdx
---
title: Basic Report
---

import { Callout, BriefTable, Tooltip } from 'briefkit';

<Callout type="info" title="Verdict">
Pick the option that best matches the kind of friction you want.
</Callout>

## Risk register

<BriefTable caption="Risk register" stickyHeader stickyFirstColumn>

| Risk | Warning sign | Mitigation |
|---|---|---|
| Schema prison | The report cannot express nuance | Keep MDX freeform |

</BriefTable>

A <Tooltip term="throwaway report">A purpose-built static site for one decision or research result.</Tooltip> should be easy to make and easy to discard.
```

## Core primitives

Briefkit v0 intentionally keeps the primitive set small:

- `ReportLayout`
- `Callout`
- `Tooltip`
- `BriefTable`

Patterns such as verdicts, source notes, facts tables, risk registers, score matrices, and decision rules should be built from those primitives instead of becoming rigid schemas.

## Examples

### README Markdown report

```text
examples/readme-report/
```

Build it with:

```bash
npm run briefkit -- build examples/readme-report
```

### Astro/MDX prototype

```text
examples/basic-report/
```

Build it with:

```bash
npm run briefkit -- build examples/basic-report
```

### Legacy static proof-of-concept

```text
examples/modlist-comparison/
  index.html
  hoh-fit.html
  styles.css
```

Open either HTML file directly in a browser.

## Design notes

The detailed design record lives in [`docs/design.md`](docs/design.md).

## Style guidelines

### Dense over pretty

Use the page as a working decision artifact. Favor tables, compact prose, and clear labels over decorative layouts.

Good:

- `Risk | Why it happens | Warning sign | Mitigation`
- `List | Download size | Installed size | Plugin count | Caveat`
- `Priority | Winner | Why | Avoid if`

Avoid:

- hero cards with vague claims;
- marketing adjectives without evidence;
- giant whitespace layouts;
- unsupported recommendations.

### Lead with the decision

Every report should answer the user's practical decision early. A verdict is a `Callout`, not a separate schema.

### Keep nuance, but make it scannable

Use tables for dense comparisons. Use paragraphs only where a narrative explanation is clearer than rows and columns.

### Use “unknown” instead of inventing facts

When a fact is missing, say `Unknown` and include the evidence caveat.

### Separate facts from interpretation

Hard facts belong in tables. Judgment belongs in verdict, fit, risk, and decision-rule sections.

### Explain jargon inline

Use inline `Tooltip` explanations for unfamiliar named systems, products, mods, acronyms, or concepts.

### Write for a human choosing, not for a stakeholder deck

Tone should be direct and useful:

- “Pick this if…”
- “Avoid this if…”
- “This burns you out when…”
- “This beats the alternative only if…”

Avoid corporate gloss.
