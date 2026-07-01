---
name: briefkit
description: Create all user-shown report-like artifacts with Briefkit. Use whenever the user asks for a report, brief, research page, decision matrix, comparison, evidence pack, audit, status/progress report, or any multi-section artifact meant to be read in a browser. Briefkit is the default for user-shown reports; do not make plain Markdown previews or hand-built HTML unless the user explicitly asks for that exact format.
---

# Briefkit

Use Briefkit to turn research or analysis into a local static report site. The report should feel like an executive decision artifact: direct verdicts, dense tables, source caveats, risks, and useful navigation. Briefkit is the default for every user-shown report-like artifact. Do not create a plain Markdown preview, standalone `.md` report file, or hand-built HTML report unless the user specifically asks for that exact format.

## Core rule

Briefkit reports can start as plain Markdown or MDX. Use `README.md` for the fastest portable report; use `index.mdx` when the report needs components, imported data, or local visuals. Write local report sources in a small folder, then run `briefkit dev`. Briefkit opens the browser itself. Do not separately open the browser or use `show_user` for the report unless the user explicitly asks.

Default report-layout pages must not start with an H1. The layout renders the page H1 from frontmatter/config title; page content should start with a callout, paragraph, table, visual, or `##` section. Briefkit warns when a default-layout page starts with Markdown `# ...` or HTML `<h1>`. Exact duplicate H1s matching the page title or report title are automatically removed from rendered output, but still indicate source cleanup is needed.

## When to use

Use this skill for:

- decision briefs;
- research summaries;
- product/vendor comparisons;
- audit or evidence packs;
- progress/status reports;
- risk registers;
- technical recommendation pages;
- dense comparison tables;
- multi-section analysis meant to be read outside chat;
- any “make me a clear throwaway website/report” request.

Do not use Briefkit for:

- long-lived product sites;
- apps or dashboards;
- highly interactive data exploration;
- quick answers where a normal chat response is enough.

## Report workflow

1. Create a report folder, usually in `/tmp` unless the user wants it kept in the repo:

   ```bash
   REPORT=/tmp/my-brief
   mkdir -p "$REPORT/pages" "$REPORT/data" "$REPORT/public"
   ```

2. For the fastest path, write `README.md`. For full Briefkit features, write `index.mdx` and optional `pages/*.{md,mdx}`.

3. Add `briefkit.config.js` only when you need explicit title, author, page order, or custom routes:

   ```js
   export default {
     title: 'Report Title',
     author: 'Ariadne',
     pages: [
       'index.mdx',
       { file: 'pages/details.mdx', title: 'Details', route: '/details/' },
     ],
   };
   ```

4. Start live reload:

   ```bash
   briefkit dev "$REPORT"
   ```

   If using the local repo without `npm link`:

   ```bash
   /Users/taylorjensen/Code/briefkit/bin/briefkit.js dev "$REPORT"
   ```

5. Let Briefkit open the browser. Do not open a second tab yourself.

6. Iterate on MDX/data files. The dev server live-reloads.

7. Use `briefkit dev` to show the user local reports. Do not run `briefkit build` just to preview or validate a local report unless the user specifically asks for a built artifact. In normal work, `build` is only needed as part of publish or when the user explicitly requests saved static output.

   If a saved artifact is explicitly requested:

   ```bash
   briefkit build "$REPORT"
   ```

   Output goes to:

   ```text
   {report-folder}/brief/
   ```

## Folder contract

Minimum plain Markdown report:

```text
report/
  README.md
```

Minimum full-featured MDX report:

```text
report/
  index.mdx
```

Full shape:

```text
report/
  briefkit.config.js
  README.md
  index.mdx
  pages/**/*.{md,mdx}
  components/**/*.{astro,tsx,jsx}
  data/**/*.{json,yaml,yml,csv}
  public/**/*
```

Rules:

- A root page is required: `index.mdx`, `index.md`, `README.mdx`, `README.md`, or `pages/index.{md,mdx}`.
- Root page priority is `index.mdx > index.md > README.mdx > README.md`.
- `pages` in config controls display order; unlisted pages still appear alphabetically after listed pages.
- Page routes default to `/filename-without-ext/`, with root index/README pages at `/`.
- Plain Markdown tables are automatically enhanced with Briefkit table styling and content-aware widths.
- Use `hidden: true` frontmatter to keep a page out of render/nav.
- Put simple files/images/PDFs in `public/` and link them as `/file-name.ext`.

## Markdown quick-start

```md
---
title: Report Title
---

## Verdict

Lead with the practical answer.

## Comparison

| Option | Best for | Caveat |
|---|---|---|
| A | Fast decisions | Less customizable |
| B | Deep analysis | More work |
```

Use this when speed and portability matter. Use MDX when you need `Callout`, `BriefTable`, `Tooltip`, imported data, or local components.

## MDX template

```mdx
---
title: Page Title
---

import { Callout, BriefTable, Tooltip } from 'briefkit';
import risks from '@report/data/risks.yaml';

<Callout type="info" title="Verdict">
Lead with the practical answer. Say what to pick, avoid, change, or watch.
</Callout>

## Hard facts

<BriefTable caption="Hard facts" stickyHeader stickyFirstColumn>

| Fact | Value | Caveat |
|---|---|---|
| Example | Known value | Unknowns and source limits go here |

</BriefTable>

## Risk register

<BriefTable
  caption="Risk register"
  columns={[
    { key: 'risk', label: 'Risk' },
    { key: 'warning', label: 'Warning sign' },
    { key: 'mitigation', label: 'Mitigation' }
  ]}
  rows={risks}
  stickyHeader
  stickyFirstColumn
/>

A <Tooltip term="jargon term">Plain-English explanation with practical effect.</Tooltip> can explain unfamiliar terms inline.
```

## Components

### `Callout`

Use for verdicts, caveats, warnings, source notes, and next actions.

Types:

```text
note | tip | info | warning | danger
```

Example:

```mdx
<Callout type="warning" title="Main caveat">
This recommendation depends on the source data being current.
</Callout>
```

Use `Callout type="info" title="Verdict"` for the opening answer. There is no separate Verdict component.

### `BriefTable`

Use for important report tables. It supports inline Markdown children or data-driven rows.

Inline:

```mdx
<BriefTable caption="Decision rules" stickyHeader stickyFirstColumn>

| If you care about… | Pick | Avoid | Reason |
|---|---|---|---|
| Low maintenance | Option A | Option C | Fewer moving parts |

</BriefTable>
```

Data-driven:

```mdx
import rows from '@report/data/risks.yaml';

<BriefTable
  caption="Risk register"
  columns={[
    { key: 'risk', label: 'Risk' },
    { key: 'warning', label: 'Warning sign' },
    { key: 'mitigation', label: 'Mitigation' }
  ]}
  rows={rows}
  stickyHeader
  stickyFirstColumn
/>
```

Prefer tables over prose when rows/columns make scanning easier.

### `Tooltip`

Use for jargon, acronyms, products, mods, systems, and ambiguous shorthand.

```mdx
<Tooltip term="Frostfall">Cold/exposure survival mod. Tracks warmth, wetness, shelter, fires, and exposure risk.</Tooltip>
```

Tooltip text should explain practical effect, not just define the term.

## Writing standards

Good reports:

- lead with the decision;
- separate facts from interpretation;
- use `Unknown` instead of inventing missing facts;
- preserve source caveats and conflicts;
- use risk registers for failure modes;
- use decision rules for “pick this if…” logic;
- explain jargon inline;
- avoid marketing language and vague praise;
- keep a single vertical reading flow.

Bad reports:

- bury the answer;
- use decorative cards instead of useful tables;
- flatten uncertainty;
- put everything in prose paragraphs;
- over-schema nuanced analysis;
- make the user horizontally scroll by default.

## Recommended sections

Use only the sections that fit the task:

1. Verdict
2. Hard facts
3. Good fit / bad fit
4. Comparison matrix
5. Score matrix
6. System-by-system analysis
7. Risk register
8. Source audit / caveats
9. Decision rules
10. Next steps

## Data files

Use `data/*.yaml` when rows are reused or easier to generate as structured data.

Example `data/risks.yaml`:

```yaml
- risk: Schema prison
  warning: The report cannot express nuance
  mitigation: Keep MDX freeform and components optional
- risk: Source conflict
  warning: Official docs and local notes disagree
  mitigation: Preserve both claims and mark confidence
```

Import with:

```mdx
import risks from '@report/data/risks.yaml';
```

## Local extensions

For one-off visuals or modules, create local components:

```text
report/components/CustomMatrix.astro
```

Import them with:

```mdx
import CustomMatrix from '@report/components/CustomMatrix.astro';

<CustomMatrix />
```

Keep local components report-specific. Only upstream patterns that are broadly reusable.

## Publishing discipline

- Use the publish server's default duration unless the user explicitly requests a different expiration.
- Do not pass `--duration` to `briefkit publish` by habit or from examples; only pass it when the requested duration matters.

## Dev-server discipline

- `briefkit dev` opens the browser in the background on macOS.
- Do not call `show_user` or manually open the URL after starting dev.
- If a dev server is already running and needs restart, kill only that port/process.
- Use `--no-open` only when the user does not want a browser opened.
- For multiple reports, use separate ports:

  ```bash
  briefkit dev /tmp/report-a --port 4331
  briefkit dev /tmp/report-b --port 4332
  ```

## Validation

For user-facing local previews, `briefkit dev "$REPORT"` is the normal validation path. Do not run `briefkit build` unless the user specifically asks for a static artifact or you are publishing.

For local repo development, run code checks as appropriate:

```bash
npm run typecheck
```

If dev/build/publish fails, fix the source or component; do not hand-edit generated `brief/` output.

## Common fixes

| Symptom | Fix |
|---|---|
| Page has no styling | Use current Briefkit core; styles are inlined from `ReportLayout`. |
| Sidebar lacks headings | Use Markdown `##` headings or HTML `<h2 id="...">`. |
| Page should not render | Add `hidden: true` to frontmatter. |
| Need a custom route | Add `{ file, title, route }` in `briefkit.config.js`. |
| Table feels bad | Prefer `BriefTable`; give clear column headers; move caveats/reasons to the last column. |
| Jargon clutters prose | Wrap first occurrence in `Tooltip`. |

## Final response to user

Keep the response short. Give:

- report path;
- dev URL if running;
- build output path only if the user specifically requested a build or publish;
- any important caveats.
