# README Markdown Brief

This example uses a plain `README.md` as the whole Briefkit report. It is intentionally generic Markdown: no imports, no MDX components, and no config file.

## Verdict

Use `README.md` when an agent needs the fastest possible report shape and the content is mostly headings, prose, lists, and tables. Use `index.mdx` when the report needs `Callout`, `BriefTable`, `Tooltip`, local components, or imported data.

## Generic Markdown table

Briefkit automatically upgrades ordinary Markdown tables with the shared report table styling, sticky headers, and content-aware column widths.

| Option | Best for | Caveat |
|---|---|---|
| `README.md` | Fast generic Markdown briefs | No component imports |
| `index.mdx` | Fully featured Briefkit reports | Slightly more ceremony |
| `pages/*.md` | Extra portable Markdown pages | No MDX-only features |
| `pages/*.mdx` | Extra component-rich pages | Briefkit-specific authoring |

## Decision rules

| If you need… | Choose | Why |
|---|---|---|
| A portable source file | `README.md` | It remains readable on GitHub and in terminals |
| Tooltips or callouts | `index.mdx` | Components require MDX |
| A quick comparison report | `README.md` | Plain Markdown tables are enhanced automatically |
| Imported YAML data | `index.mdx` | Imports are an MDX feature |

## Notes

- `README.md` routes to `/`.
- `index.mdx` takes priority if both files exist.
- Markdown tables are enhanced at render time; the source stays portable.
