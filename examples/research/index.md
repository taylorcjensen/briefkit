---
title: Research brief — What can a Briefkit report contain?
description: A source-linked example of answering a narrow implementation question without guessing.
---

> **Use Markdown for prose-first reports; choose MDX when you need components.** Both can be the index page. A folder also supports `pages/` for additional pages. Do not assume an arbitrary nested Markdown file is discovered unless it is configured.

**Question:** What source layout can an author actually hand to the CLI? This example uses the Briefkit implementation as its primary source rather than relying on a feature list alone.

## Evidence ledger

| Finding | Evidence | Confidence | Boundary |
|---|---|---|---|
| Root `index.md`, `index.mdx`, and `README.md` are candidates | [`ROOT_PAGE_CANDIDATES` in report loader](https://github.com/taylorcjensen/briefkit/blob/main/src/lib/report.ts) | High | The loader chooses the first present candidate in its configured order |
| `pages/` is scanned recursively for `.md` and `.mdx` | [`discoverMdxFiles` and `collectMdxFiles`](https://github.com/taylorcjensen/briefkit/blob/main/src/lib/report.ts) | High | An index is still required |
| Additional source files can be listed in config | [`normalizePageEntries` and configured-entry lookup](https://github.com/taylorcjensen/briefkit/blob/main/src/lib/report.ts) | High | Configured missing files cause an error |
| MDX pages can import package components | [Package exports](https://github.com/taylorcjensen/briefkit/blob/main/src/index.ts) and [authoring guide](https://github.com/taylorcjensen/briefkit#full-featured-mdx-report) | High | Import only components you actually use |

## Minimal reproducible layout

```text
my-brief/
├── index.md
└── pages/
    └── evidence.md
```

Put the decision first in `index.md` and keep the detailed source trail in `pages/evidence.md`. For custom components, rename a page to `.mdx` and import from `briefkit` as the [README explains](https://github.com/taylorcjensen/briefkit#full-featured-mdx-report).

## Unanswered questions

| Question | Why it matters | Next check |
|---|---|---|
| Which layout best fits this reader? | Navigation and density depend on the audience | Build a first draft and review with a reader |
| Will the report need assets? | Images may need a `public/` directory | Check the authoring guide's asset rules |

## Source audit

These links target the repository's `main` branch and may change after this example is written. For a consequential decision, pin links to a commit and verify the installed version. This brief summarizes code behavior; it does not assert that a remote deployment is current.
