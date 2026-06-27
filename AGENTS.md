# Briefkit Agent Instructions

Use these rules when creating reports with Briefkit. They are for agents, not end-user README content.

## Release and publishing rules

Do not manually run `npm publish` or publish the Docker container from a local machine. NPM package publishing and publish-server container publishing are handled by GitHub Actions.

For releases:

1. Update `package.json` to the next version.
2. Commit the version and code changes.
3. Create and push a matching version tag, e.g. `v0.1.5` for package version `0.1.5`.
4. Let GitHub Actions publish the npm package and container image.

The version tag must match the package version exactly with a leading `v`.

## Writing and layout best practices

### Lead with the decision

The first screen should say what to pick, avoid, change, or watch. A verdict is usually a `Callout`, not a custom schema.

### Prefer dense tables over decorative cards

Use tables for comparisons, facts, risk registers, and decision rules.

Good table shapes:

- `Risk | Why it happens | Warning sign | Mitigation`
- `Option | Best for | Avoid if | Caveat`
- `Priority | Winner | Why | Confidence`
- `Fact | Value | Source | Caveat`

Avoid:

- hero cards with vague claims;
- marketing adjectives without evidence;
- giant whitespace layouts;
- unsupported recommendations;
- horizontal-scroll tables when the content can be redesigned.

### Keep one vertical reading flow

Briefkit tables are designed for executive-summary reading. Put long explanation, evidence, or caveat columns at the end so extra width goes where it helps most.

### Say `Unknown` instead of inventing facts

If a fact is missing, say `Unknown` and include the caveat. Do not imply that an unknown value is zero or irrelevant.

### Separate facts from interpretation

Hard facts belong in tables. Judgment belongs in verdict, fit, risk, and decision-rule sections.

### Explain jargon inline

Use `Tooltip` for unfamiliar named systems, products, mods, acronyms, or concepts.

### Write for the person making the choice

Use direct language:

- “Pick this if…”
- “Avoid this if…”
- “This breaks down when…”
- “This beats the alternative only if…”

Avoid corporate gloss.
