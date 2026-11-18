# Outstanding limitations

Updated after Phase 1. Each item names the phase expected to address it.

## Not implemented yet

| Area | Current state | Planned |
|---|---|---|
| Visual laboratory | Empty state plus a legend of the visual vocabulary. No operations, playback or simulation | Phase 2 |
| Operation explanations | Explain panel shows file facts only | Phases 2–3 |
| Python static analysis | Outline only (functions, classes, methods). No expressions, calls, imports or control flow | Phase 3 (Tree-sitter WASM evaluation) |
| ZIP import | Disabled on the start page. Only the bundled demo project can be opened | Phase 4 |
| File previews | Images, SVG, CSV tables, notebook cells and JSON/YAML trees are not rendered. Text formats show as source; images and unknown types show metadata only | Phase 4 |
| Cross-file navigation | None. Imports are not resolved | Phase 5 |
| Dependency / asset explorers | None | Phase 5 |
| Persistent projects | None. Only UI preferences are stored (localStorage) | Phase 6 |
| Large files | Whole file loaded into the viewer; no size limits or virtualised loading yet | Phase 7 |
| End-to-end tests / deployment | Unit and component tests only; not deployed | Phase 8 |

## Known caveats in what exists

- **Outline parser.** Lezer is an error-recovering parser. On malformed code it may produce a partial outline. The UI reports the number of recovered regions so this is never silent.
- **Line endings.** CodeMirror shows CRLF files line by line like LF files. The original bytes are untouched, but the viewer doesn't show which line-ending style a file uses.
- **Byte sizes of demo files** are computed from their UTF-8 text. That is exact for the bundled text files. Real imports (Phase 4) will use archive byte counts.
- **File-type detection** uses names/extensions only. Content sniffing against MIME spoofing comes with ZIP import (Phase 4).
- **Explorer accessibility.** The tree uses `role="tree"` with buttons but no roving-tabindex arrow-key navigation yet.
- **Dev-dependency audit.** `npm audit` reports a high-severity ReDoS advisory in `picomatch`, pulled in by Vite and Vitest (build and test tooling only, not shipped to browsers). The only automatic fix downgrades Vite to 6.x, which was not applied. Revisit when upstream releases a patched version.
