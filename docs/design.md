# Briefkit Design Notes

Briefkit is a lightweight static report-site toolkit for agents that need to turn research into clear, attractive, decision-oriented throwaway websites.

These notes capture approved design decisions and open questions during early design.

## Product thesis

Briefkit is a report forge, not an agent framework, CMS, dashboard product, or backend service.

Agents should be able to create polished, decision-oriented static sites quickly from local files while reusing one shared Briefkit core.

Core priorities:

- static output;
- local and portable;
- MDX-first authoring;
- dense, scannable, informational reports;
- good defaults with escape hatches;
- reusable modules without forcing a rigid schema;
- one shared installed core usable by many simultaneous report folders.

## Architecture model

Briefkit core is installed once and reused by many local report folders.

```text
~/Code/briefkit/                 # shared core toolkit
  bin/briefkit
  src/layouts/
  src/components/
  src/styles/
  astro.base.config.mjs

/tmp/skyrim-brief/               # local report source only
  index.mdx
  components/
  data/
  public/

/tmp/wagos-brief/                # another local report source only
  index.mdx
  components/
  data/
  public/
```

The CLI should support concurrent dev servers using the same core:

```bash
briefkit dev /tmp/skyrim-brief --port 4311
briefkit dev /tmp/wagos-brief --port 4312
```

Each report gets isolated generated/cache/build directories so Astro/Vite state does not collide.

Briefkit should hide Astro ceremony. Users and agents should not need to copy a full Astro app for every report.

## Authoring model

Reports are MDX-first.

A report can use:

- freeform Markdown/MDX prose;
- raw HTML/JSX-like markup where needed;
- reusable Briefkit core components;
- local report-specific components;
- local data files.

Example:

```mdx
---
title: Vendor Decision Brief
---

import { Callout, BriefTable, Tooltip } from "briefkit";
import WeirdMatrix from "@report/components/WeirdMatrix.astro";
import risks from "@report/data/risks.yaml";

# Vendor Decision Brief

<Callout type="info" title="Verdict">
Pick Vendor B unless support risk dominates.
</Callout>

<WeirdMatrix />

<BriefTable
  caption="Risk register"
  columns={[
    { key: "risk", label: "Risk" },
    { key: "warning", label: "Warning sign" },
    { key: "mitigation", label: "Mitigation" }
  ]}
  rows={risks}
  stickyHeader
  stickyFirstColumn
/>
```

Structured data should be used where useful, but Briefkit should not become a schema prison.

Good structured candidates:

- facts;
- risks;
- scores;
- sources;
- glossary;
- decision rules.

Freeform content should remain first-class for analysis, caveats, recommendations, and narrative reasoning.

## Report folder contract

The minimum valid report is:

```text
my-report/
  index.mdx
```

Supported optional structure:

```text
my-report/
  index.mdx
  pages/**/*.mdx
  components/**/*.{astro,tsx,jsx}
  data/**/*.{json,yaml,yml,csv}
  public/**/*
  briefkit.config.{ts,js,mjs}
```

Rules:

- `index.mdx` or `pages/index.mdx` is required.
- `components/` is for local one-off modules.
- `data/` is for local report data.
- `public/` is copied/served as simple static files.
- `briefkit.config` is optional.

## Local imports

Reports should be able to import local files through a stable alias:

```mdx
import CustomThing from "@report/components/CustomThing.astro";
import risks from "@report/data/risks.yaml";
```

This avoids fragile relative paths for nested pages.

## Assets

Briefkit defaults to simple static assets.

```text
my-report/
  public/
    chart.png
    source-screenshot.jpg
    appendix.pdf
```

MDX references:

```mdx
![Chart](/chart.png)

<a href="/appendix.pdf">Download appendix</a>
```

Advanced bundled assets may be considered later, but are not required for the initial design.

## Layout behavior

Pages are automatically wrapped in the standard Briefkit report layout by default.

Default frontmatter behavior:

```mdx
---
title: Skyrim Decision
---
```

is equivalent to:

```mdx
---
title: Skyrim Decision
layout: report
---
```

Escape hatches:

```mdx
---
title: Raw Appendix
layout: none
---
```

```mdx
---
title: Custom Page
layout: custom
customLayout: "@report/components/MyLayout.astro"
---
```

Future built-in layouts may include `wide` or `article`.

## Navigation and table of contents

Default layout includes a sidebar navigation/table of contents.

Sidebar behavior:

- generated page navigation from discovered MDX files;
- generated in-page table of contents from headings;
- on mobile, sidebar should collapse above content or into a details block;
- in print, sidebar should be hidden.

For a single-page report, sidebar shows heading TOC.

For a multi-page report, sidebar shows:

```text
Pages
- Main matrix
- HOH fit analysis

On this page
- Verdict
- Hard facts
- Risk register
```

Page ordering:

1. explicit order from `briefkit.config` if declared;
2. otherwise alphabetical;
3. `index.mdx` should be first when no explicit order exists.

Page label:

```text
navTitle || title || filename
```

Heading anchors are generated so agents can link to `page#section`, and the sidebar exposes those links.

Config/frontmatter escape hatches may later include:

```mdx
---
toc: false
---
```

or:

```ts
export default {
  toc: true,
};
```

## Route model

Each MDX page renders as:

```text
/mdx-filename-without-ext/
```

Examples:

```text
index.mdx              -> /
hoh-fit.mdx            -> /hoh-fit/
pages/sources.mdx      -> /sources/
pages/vendor-risk.mdx  -> /vendor-risk/
```

Routes are based on file basename, not nested source path.

Collision rule:

```text
pages/a/sources.mdx
pages/b/sources.mdx
```

would both map to:

```text
/sources/
```

Briefkit should error and require explicit route configuration.

Explicit route override:

```ts
export default {
  pages: [
    { file: "index.mdx", route: "/" },
    { file: "pages/hoh-fit.mdx", route: "/hoh-fit/" },
    { file: "pages/source-notes.mdx", route: "/sources/" },
  ],
};
```

## Component/module API

Briefkit should support both children-first and data-driven components. The right API depends on the module.

General rule:

- prose-heavy blocks should be children-first;
- repeatable tables and matrices should be data-driven;
- plain MDX and Markdown tables should remain valid when clearer than a component.

Examples:

```mdx
<Callout type="warning" title="Main caveat">
Do not add plugins casually. This list only has 11 standard plugin slots free.
</Callout>
```

Supported callout types for v0:

- `note`
- `tip`
- `info`
- `warning`
- `danger`

Callouts should be compact, visually distinct, readable in light and dark modes, and appropriate for decision reports. They should not become giant marketing cards.

```mdx
import risks from "@report/data/risks.yaml";

<BriefTable
  caption="Risk register"
  columns={[
    { key: "risk", label: "Risk" },
    { key: "warning", label: "Warning sign" },
    { key: "mitigation", label: "Mitigation" }
  ]}
  rows={risks}
  stickyHeader
  stickyFirstColumn
/>
```

`BriefTable` should support both inline children and data-driven rows.

Inline mode is fastest for one-off reports:

```mdx
<BriefTable caption="Risk register" stickyHeader stickyFirstColumn>
| Risk | Warning sign | Mitigation |
|---|---|---|
| Maintenance fatigue | You skip travel prep | Use inns and jobs |
</BriefTable>
```

Data mode is useful when data already exists in `data/` or is reused across pages:

```mdx
import risks from "@report/data/risks.yaml";

<BriefTable
  caption="Risk register"
  columns={[
    { key: "risk", label: "Risk" },
    { key: "warning", label: "Warning sign" },
    { key: "mitigation", label: "Mitigation" }
  ]}
  rows={risks}
  stickyHeader
  stickyFirstColumn
/>
```

`BriefTable` options for v0:

- `caption`: table title;
- `columns`: data-mode column mapping;
- `rows`: data-mode row objects;
- `stickyHeader`: sticky top header row;
- `stickyFirstColumn`: sticky first column, styled as row headers;
- `class`: escape hatch.

Rules:

- normal Markdown tables should still be styled decently;
- `BriefTable` is the preferred wrapper for important report tables;
- if `rows`/`columns` are provided, render from data;
- if no `rows`/`columns` are provided, render children;
- if both data and children are provided, error rather than silently choosing one.

Tooltips should be inline by default. Reports are throwaway artifacts, so the fastest and clearest authoring path is to define the explanation where the term appears.

Example:

```mdx
<Tooltip term="Frostfall">Cold/exposure survival mod.</Tooltip>
```

A data-driven glossary may be considered later if repeated-term management becomes painful, but it is not a v0 requirement.

Components should not require large prop objects when plain MDX is clearer.

## v0 core modules

Briefkit v0 should keep the primitive component set intentionally small:

- `ReportLayout`
- `Callout`
- `Tooltip`
- `BriefTable`

Other report structures are documented patterns built from those primitives:

- verdict: `Callout`
- source notes: `Callout` or `BriefTable`
- risk register: `BriefTable`
- facts table: `BriefTable`
- score matrix: `BriefTable`
- decision rules: `Callout` or `BriefTable`

Modules should be useful primitives, not a rigid report schema.

## Header and footer

Standard report header shows the page title only. No v0 standard subtitle, date, status, author, updated, or confidence metadata in the header. Reports that need that information can put it in the body with a `Callout` or `BriefTable`.

Standard report footer should credit the generator and show build time.

Config example:

```ts
export default {
  author: "Claude",
};
```

Footer with author:

```text
Made by Claude with Briefkit | {Build Time}
```

Footer without author:

```text
Made with Briefkit | {Build Time}
```

The author field belongs in config, not page frontmatter.

## Theme and color mode

Default visual theme is light paper-first: dense, polished, readable, and print-friendly.

The standard layout should support a soft dark mode for late-night reading. Dark mode should be gentle, not pure black/high-contrast neon.

Theme implementation should use CSS tokens and a document attribute, not separate component sets.

Color mode behavior:

- default is `auto`;
- header includes a light/dark/auto toggle;
- user choice should apply client-side for browsing;
- build-time option can force one mode for generated output;
- color mode is not controlled in page frontmatter.

Color mode is controlled by runtime UI and CLI/build options, not by report config or page frontmatter.

CLI examples:

```bash
briefkit dev ./report --color-mode auto
briefkit build ./report --color-mode dark
```

Suggested token posture:

| Token | Light | Dark |
|---|---|---|
| Background | warm off-white | charcoal / ink gray |
| Paper | white | slightly lighter charcoal |
| Text | near-black | warm light gray |
| Muted | gray | soft gray |
| Lines | warm gray | low-contrast slate |
| Accent | muted brown/blue/green | desaturated teal/blue |
| Tables | white with subtle header fill | dark panels with slightly raised headers |
| Tooltip | pale yellow | muted navy/slate panel |

## CLI command surface

Briefkit v0 should have only two primary commands:

```bash
briefkit dev ./report
briefkit build ./report
```

`dev` is the main workflow. Most reports are expected to be created, read with live reload, and then discarded without a final build.

`dev` behavior:

- starts a live-reload local server;
- chooses an available port unless `--port` is provided;
- watches MDX, local components, data, and public assets;
- uses the shared Briefkit core without copying it into the report folder;
- isolates generated/cache files per running report so concurrent dev servers can run safely;
- opens the browser automatically by default;
- prints that the browser was opened.

Example output:

```text
Briefkit dev server running
Report: /tmp/skyrim-brief
URL: http://localhost:4311
Opened browser window.
```

Agents should not separately open the browser after running `briefkit dev`; Briefkit owns browser-opening to avoid duplicate tabs/windows.

Optional flag:

```bash
briefkit dev ./report --no-open
```

Example concurrent usage:

```bash
briefkit dev /tmp/skyrim-brief --port 4311
briefkit dev /tmp/wagos-brief --port 4312
```

`build` behavior:

- generates a static site from a report folder;
- supports build-time options such as forced color mode;
- is for the minority case where the throwaway site needs to be saved, shared, or deployed.

No `preview` command for v0. No `export` command for v0.

## Config file

Optional config file:

```text
briefkit.config.{ts,js,mjs}
```

v0 shape:

```ts
export default {
  title: "Skyrim Modlist Decision",
  author: "Claude",
  pages: [
    "index.mdx",
    { file: "pages/hoh-fit.mdx", title: "HOH fit", route: "/hoh-fit/" },
  ],
};
```

Fields:

- `title`: optional whole-report title/name;
- `author`: footer credit;
- `pages`: explicit page order and optional title/route overrides.

Color mode is not a config field. It is controlled by runtime UI and CLI/build options.

Page ordering/inclusion rules:

- if `pages` exists, listed pages appear first in that order;
- unlisted discovered pages are still included afterward, sorted alphabetically;
- if no `pages`, all discovered pages are sorted alphabetically, with `index.mdx` first;
- page title defaults to frontmatter `title`, then config `title`, then filename unless a config page entry overrides it;
- route defaults to `/filename-without-ext/`, with `index.mdx` as `/`.

Hidden pages use frontmatter:

```mdx
---
title: Scratch Notes
hidden: true
---
```

Hidden pages are not rendered as routes and do not appear in navigation.

## Generated Astro workspaces

Briefkit should hide Astro ceremony by generating disposable Astro wrapper workspaces under the OS temp directory.

Report folders stay simple and do not contain copied Briefkit core or generated Astro project files.

Example report folder:

```text
/tmp/skyrim-brief/
  index.mdx
  pages/hoh-fit.mdx
  data/
  components/
```

Generated workspace:

```text
/tmp/briefkit/skyrim-brief-a8f31/
  astro.config.mjs
  package.json
  src/pages/index.astro
  src/pages/hoh-fit.astro
```

The workspace is disposable. If `/tmp/briefkit/*` disappears, Briefkit recreates it on the next `dev` or `build`.

For concurrent dev servers, each report path should get an isolated workspace identity. If the same report runs twice, include port or run id to avoid collisions.

Aliases in the generated Astro config should include:

```text
briefkit -> shared Briefkit core
@report -> current report folder
```

## Build output

Default build output is:

```text
{report-folder}/brief/
```

Example:

```bash
briefkit build /tmp/skyrim-brief
```

writes to:

```text
/tmp/skyrim-brief/brief/
```

Override:

```bash
briefkit build /tmp/skyrim-brief --out /tmp/brief/skyrim-modlist-decision
```

The whole-report title comes from:

```text
config.title -> index page frontmatter title -> report folder name
```

## Package/install model

Briefkit should be developed as a normal npm package in this repo with a global CLI bin.

v0 local development:

```bash
npm install
npm link
briefkit dev /tmp/my-report
```

Future published usage:

```bash
npm install -g briefkit
briefkit dev /tmp/my-report
```

Package shape:

```json
{
  "name": "briefkit",
  "bin": {
    "briefkit": "./bin/briefkit.js"
  }
}
```

The package should expose the CLI plus reusable Astro/MDX components imported as `briefkit`.

## Automatic wrapping and rendering

The CLI should discover pages, read frontmatter, and generate one Astro wrapper route per visible MDX page in the temp workspace.

Each generated wrapper imports the report MDX page and renders it inside `ReportLayout` unless the page opts out with `layout: none` or supplies a custom layout.

The wrapper passes layout data including:

- current page info;
- visible pages for sidebar navigation;
- current page headings for sidebar TOC;
- report config;
- build time;
- color mode.

## Open questions

- Whether route output should support `.html` mode later for direct file browsing.
