# Color naming data

- `css.json` lists the opaque keyword-to-hex mappings from [CSS Color 4 §6.1](https://www.w3.org/TR/css-color-4/#named-colors). It includes aliases and excludes contextual keywords and `transparent`.
- `colornames.min.json` is the full hex-to-name dictionary from David Aerne's [Color Name List](https://github.com/meodai/color-names), version [14.86.0](https://www.npmjs.com/package/color-name-list/v/14.86.0). It is an unmodified copy of `dist/colornames.min.json` from the npm tarball, with 32,004 entries. To refresh it, replace the file and [MIT license](LICENSE.color-name-list) from a pinned upstream release and update this note.
  - SHA-256: `a8f4408e5fb2d3d3c7dac913495c92db06e464e70c332a83aaaef3ee9c4cb320`

Briefkit uses these lists at build time. A built report gets the matching labels, not the dictionaries.
