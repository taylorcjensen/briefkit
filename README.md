# Briefkit

Briefkit is a lightweight pattern for turning AI research into local, static, decision-oriented web pages.

It is not an agent framework, dashboard backend, or structured-data prison. The goal is simple: preserve nuanced analysis while reusing a consistent report shell, dense table style, navigation, glossary hover behavior, and source/risk/decision sections.

## Design notes

The evolving Astro/MDX toolkit design lives in [`docs/design.md`](docs/design.md).

## Current example

A copy of the current Skyrim modlist comparison site lives at:

`examples/modlist-comparison/`

Open either page directly in a browser:

- `examples/modlist-comparison/index.html`
- `examples/modlist-comparison/hoh-fit.html`

## What the current site does

The current site is a static HTML/CSS report with two pages:

1. `index.html` — four-way decision matrix comparing Skyrim Unification Project, JOJ, Lost Legacy 2, and Hymns of Hircine.
2. `hoh-fit.html` — focused fit-analysis page for Hymns of Hircine as the favored option.

The pages are designed around decision support, not visual polish:

- hard facts first: version, update recency, install size, plugin counts, standard plugin headroom, display counts where known;
- dense comparison tables instead of marketing cards;
- score matrices with caveats;
- system-by-system comparisons;
- risk registers;
- fit / anti-fit criteria;
- decision rules;
- source notes and confidence caveats;
- inline glossary tooltips for terms/mod names the reader may not know.

## Style guidelines

### 1. Dense over pretty

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

### 2. Lead with the decision

Every report should answer the user's practical decision early.

Recommended top sections:

1. Verdict
2. Hard facts
3. Good fit / bad fit
4. Comparison or score matrix
5. Risk register
6. Evidence/source notes

### 3. Keep nuance, but make it scannable

Use tables for dense comparisons. Use paragraphs only where a narrative explanation is clearer than rows and columns.

A good report should be understandable by skimming row headers alone.

### 4. Use “unknown” instead of inventing facts

When a fact is missing, say `Unknown` and include the evidence caveat.

Example:

`LOTD display count: Unknown exact count found; docs confirm LOTD integration but no explicit total surfaced.`

### 5. Separate facts from interpretation

Hard facts belong in a fact table. Judgment belongs in verdict, fit, risk, and decision-rule sections.

Example:

- Fact: `3,698 active plugins; 243 / 254 standard slots used.`
- Interpretation: `Do not plan to casually add plugins.`

### 6. Explain jargon inline

Whenever a report references unfamiliar named systems, products, mods, acronyms, or concepts, wrap them in a tooltip.

Current tooltip pattern:

```html
<span class="tip" tabindex="0">Frostfall<span>Cold/exposure survival mod. Tracks warmth, wetness, weather, shelter, fires, and exposure risk.</span></span>
```

Tooltip rules:

- underline only; no bold styling;
- plain-English explanation;
- explain practical effect, not just definition;
- use `tabindex="0"` so keyboard focus also shows the tooltip.

### 7. Prefer decision-oriented section types

Reusable report section patterns:

- Executive verdict
- Hard facts / install burden / update status
- Score matrix
- Fit / anti-fit table
- Good reasons / bad reasons
- System explainer
- Option-vs-option matrix
- Risk register
- Burnout/failure forecast
- Recommended action plan
- Source audit
- Glossary

### 8. Use source confidence and caveats

Research-backed reports should include source quality notes:

- local file/report;
- official docs;
- GitHub/Nexus/release page;
- search result snippet;
- stale/contradictory source;
- unknown/unverified.

When sources conflict, preserve the conflict rather than flattening it.

### 9. Write for a human choosing, not for a stakeholder deck

Tone should be direct and useful:

- “Pick this if…”
- “Avoid this if…”
- “This burns you out when…”
- “This beats the alternative only if…”

Avoid corporate gloss.

### 10. Static, local, portable

The current pattern uses plain static files:

- no build step;
- no external dependencies;
- no analytics;
- no framework runtime;
- open directly from disk.

Future versions may use Astro/MDX, but should preserve the same output priorities: static, local, dense, inspectable.

## Current file structure

```text
examples/modlist-comparison/
  index.html       # four-way comparison report
  hoh-fit.html     # focused favored-option report
  styles.css       # dense report styling and tooltip behavior
```

## CSS conventions

The current style uses:

- light theme;
- max-width content container;
- sticky table headers;
- fixed table layout for dense comparisons;
- print-friendly media rules;
- simple nav links;
- dotted-underlined hover/focus glossary terms.

Key CSS class:

```css
.tip { ... }
.tip > span { ... }
.tip:hover > span,
.tip:focus > span { display: block; }
```

## Future direction

Briefkit is expected to become an Astro/MDX toolkit with one shared installed core and many local throwaway report folders.

Initial core primitives should stay small:

- `ReportLayout`
- `Callout`
- `Tooltip`
- `BriefTable`

Report structures such as verdicts, risk registers, source notes, facts tables, score matrices, and decision rules should be patterns built from those primitives rather than rigid schemas.

The important design decision is that the body should remain flexible. The toolkit should provide reusable modules and styling, not force every report into rigid JSON.
