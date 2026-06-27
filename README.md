# Briefkit

[Read this README as a Briefkit report](https://taylorcjensen.github.io/briefkit/)

Briefkit turns Markdown or MDX folders into local, static, decision-oriented report websites.

It is built for agent-authored briefs: research summaries, comparisons, evidence packs, audits, risk registers, status reports, and one-off decision pages. The source stays simple and portable. Briefkit supplies the shared shell: layout, sidebar navigation, heading TOC, dark/light/auto theme, callouts, tooltips, and table normalization.

Briefkit is not an app framework, dashboard backend, CMS, or structured-data prison. The goal is to keep nuanced analysis easy to write while making the result readable enough to hand to a human.

## What it does

| Need | Briefkit behavior |
|---|---|
| Fast local report | Run `briefkit dev /path/to/report` and get a live site |
| Portable source | Use `README.md`, `index.md`, or `pages/*.md` |
| Full components | Use `index.mdx` or `pages/*.mdx` |
| Scannable tables | Markdown tables are automatically styled and width-normalized |
| Decision artifacts | Use callouts, dense tables, sidebars, and heading TOCs |
| Throwaway output | Build static files to `{report-folder}/brief/` |

## Install

### From npm

```bash
npm install -g briefkit
```

Then run:

```bash
briefkit dev /path/to/report
briefkit build /path/to/report
briefkit publish /path/to/report
```

### From this repository

```bash
git clone https://github.com/taylorcjensen/briefkit.git
cd briefkit
npm install
npm link
```

Then run:

```bash
briefkit dev examples/readme-report
briefkit build examples/basic-report
```

Without linking:

```bash
npm run briefkit -- dev examples/readme-report
npm run briefkit -- build examples/basic-report
```

## Commands

```bash
briefkit dev [report-dir] [--port 4311] [--no-open] [--color-mode auto|light|dark]
briefkit build [report-dir] [--out ./brief] [--color-mode auto|light|dark]
briefkit publish [report-dir] [--duration 90d|3mo|1y|forever] [--target https://briefs.example.com] [--api-key KEY]
briefkit unpublish <url-or-slug> [--target https://briefs.example.com] [--api-key KEY]
briefkit publish-config set --target https://briefs.example.com --api-key KEY
```

| Command | Use it for | Output |
|---|---|---|
| `dev` | Primary authoring workflow | Live Astro dev server |
| `build` | Saved static artifact | `{report-folder}/brief/` by default |
| `publish` | Build and upload a static brief | Hosted URL from your publish server |
| `unpublish` | Delete a hosted brief by URL or slug | Removed static brief |
| `publish-config` | Save a default publish target and API key | `~/.config/briefkit/publish.json` |

`briefkit dev` opens the browser by default. Agent workflows should not open a separate browser tab after running it. Use `--no-open` only when you explicitly do not want a browser opened.

Build/dev generated Astro workspaces live under the OS temp directory. The report folder only needs to contain your source files and optional build output.

## Publishing briefs

Briefkit includes a tiny Docker publish server in `publish-server/`. It accepts built static files from `briefkit publish`, stores them under `/briefs`, and serves each brief at:

```text
{configured-domain}/{article-title-slug}/
```

Duplicate titles receive numeric suffixes: `article-title-slug-2`, `article-title-slug-3`, and so on.

Run the server from the published image:

```bash
docker run -d \
  --name briefkit-publish \
  -p 8080:8080 \
  -v /path/on/host/briefs:/briefs \
  -e BRIEFKIT_DOMAIN=https://briefs.example.com \
  -e BRIEFKIT_API_KEYS=key-one,key-two \
  -e BRIEFKIT_DEFAULT_DURATION=3mo \
  ghcr.io/taylorcjensen/briefkit/publish-server:latest
```

Or build it locally:

```bash
docker build -t briefkit-publish-server ./publish-server
```

The GitHub Actions workflow publishes multi-architecture images to `ghcr.io/taylorcjensen/briefkit/publish-server` on `main`, releases, and manual dispatches.

Server environment:

| Variable | Required | Default | Meaning |
|---|---:|---:|---|
| `BRIEFKIT_DOMAIN` | No | `http://localhost:8080` | Public base URL returned after publish |
| `BRIEFKIT_API_KEYS` | Yes | none | Comma-separated valid API keys |
| `BRIEFKIT_DEFAULT_DURATION` | No | `3mo` | Used when the client omits `--duration` |
| `BRIEFKIT_STORAGE_DIR` | No | `/briefs` | Container storage path |
| `BRIEFKIT_MAX_BODY_BYTES` | No | `52428800` | Maximum JSON upload size |

Configure the client once:

```bash
briefkit publish-config set --target https://briefs.example.com --api-key key-one
```

Then publish:

```bash
briefkit publish /path/to/report
briefkit publish /path/to/report --duration 30d
briefkit publish /path/to/report --duration forever
briefkit unpublish article-title-slug
briefkit unpublish https://briefs.example.com/article-title-slug/
```

Durations support `d`, `w`, `mo`, `y`, and `forever`. Expired briefs return 404 and are deleted by the server cleanup loop. Briefs set to `forever` can be removed with `briefkit unpublish`.

## Quick start: plain Markdown

A folder with only `README.md` is a valid Briefkit report.

```bash
mkdir /tmp/vendor-brief
cat > /tmp/vendor-brief/README.md <<'EOF'
# Vendor Decision Brief

## Verdict

Pick Option A if you need the lowest maintenance path.

## Comparison

| Option | Best for | Caveat |
|---|---|---|
| A | Fast decisions | Less customizable |
| B | Deep analysis | More work |

## Decision rule

Choose B only if the extra analysis time changes the decision.
EOF

briefkit dev /tmp/vendor-brief
```

Briefkit will:

- route `README.md` to `/`;
- use the first `# Heading` as the page title;
- avoid rendering that title twice;
- add sidebar navigation from page headings;
- upgrade Markdown tables with Briefkit table styling and content-aware widths.

Use Markdown when the report should stay generic and portable.

## Full-featured MDX report

Use MDX when you need Briefkit components, imported data, or local components.

```text
my-report/
  briefkit.config.js
  index.mdx
  pages/details.mdx
  data/risks.yaml
  public/source.pdf
```

`briefkit.config.js`:

```js
export default {
  title: 'Vendor Decision Brief',
  author: 'Ariadne',
  pages: [
    'index.mdx',
    { file: 'pages/details.mdx', title: 'Details', route: '/details/' },
  ],
};
```

`index.mdx`:

```mdx
---
title: Vendor Decision Brief
---

import { Callout, BriefTable, Tooltip } from 'briefkit';
import risks from '@report/data/risks.yaml';

<Callout type="info" title="Verdict">
Pick Option A unless the extra evidence from Option B would change the decision.
</Callout>

## Risk register

<BriefTable
  caption="Risk register"
  columns={[
    { key: 'risk', label: 'Risk' },
    { key: 'warning', label: 'Warning sign' },
    { key: 'mitigation', label: 'Mitigation' },
  ]}
  rows={risks}
  stickyHeader
  stickyFirstColumn
/>

Use a <Tooltip term="throwaway report">purpose-built static site for one decision or research result.</Tooltip>
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

Full shape:

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

Root page priority:

```text
index.mdx > index.md > README.mdx > README.md
```

Routes:

| Source file | Route |
|---|---:|
| `index.mdx` | `/` |
| `index.md` | `/` |
| `README.mdx` | `/` |
| `README.md` | `/` |
| `pages/details.mdx` | `/details/` |
| `pages/details.md` | `/details/` |

Rules:

- `pages` in config controls page order.
- Unlisted pages are included alphabetically after configured pages.
- `hidden: true` frontmatter keeps a page out of render/nav.
- `layout: none` renders page content without the Briefkit shell.
- `layout: custom` with `customLayout` lets a page use a local layout.
- Files in `public/` are copied to the static output and can be linked from `/file-name.ext`.

## Components

Briefkit v0 intentionally keeps the primitive set small.

| Component | Use it for |
|---|---|
| `ReportLayout` | Shared shell used automatically by the CLI |
| `Callout` | Verdicts, notes, caveats, warnings, source notes |
| `Tooltip` | Inline explanations for jargon and acronyms |
| `BriefTable` | Explicit tables with captions, sticky columns, or data rows |

### Callout

```mdx
<Callout type="warning" title="Main caveat">
This recommendation depends on the source data being current.
</Callout>
```

Types:

```text
note | tip | info | warning | danger
```

### Tooltip

```mdx
<Tooltip term="ETL">Extract, transform, load: a pipeline that moves and reshapes data.</Tooltip>
```

Tooltip text should explain practical effect, not merely expand an acronym.

### BriefTable

Inline Markdown table:

```mdx
<BriefTable caption="Decision matrix" stickyHeader stickyFirstColumn>

| Option | Best for | Caveat |
|---|---|---|
| A | Fast decisions | Less customizable |
| B | Deep analysis | More work |

</BriefTable>
```

Data-driven table:

```mdx
import rows from '@report/data/risks.yaml';

<BriefTable
  caption="Risk register"
  columns={[
    { key: 'risk', label: 'Risk' },
    { key: 'warning', label: 'Warning sign' },
    { key: 'mitigation', label: 'Mitigation' },
  ]}
  rows={rows}
  stickyHeader
  stickyFirstColumn
/>
```

Ordinary Markdown tables are enhanced automatically. Use `BriefTable` when you need a caption, sticky first column, data rows, or explicit control.

## Data and local imports

YAML files can be imported directly from MDX:

```yaml
# data/risks.yaml
- risk: Source conflict
  warning: Official docs and local notes disagree
  mitigation: Preserve both claims and mark confidence
```

```mdx
import risks from '@report/data/risks.yaml';
```

Use `@report` for imports rooted at the report folder:

```mdx
import CustomMatrix from '@report/components/CustomMatrix.astro';
import facts from '@report/data/facts.yaml';
```

## Recommended report sections

Use only the sections that fit the task.

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

## Example site

This README is the example report. Build it with:

```bash
npm run briefkit -- build . --out ./dist
```

The generated site includes the README at `/` and the design notes at `/design/`.

## Design notes

The detailed design record is included as a second Briefkit page: [Design notes](design/).

## License

MIT
