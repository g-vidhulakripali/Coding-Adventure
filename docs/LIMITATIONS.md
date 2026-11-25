# Outstanding limitations

Updated after Phase 2. Each item names the phase expected to address it.

## Not implemented yet

| Area | Current state | Planned |
|---|---|---|
| Simulation coverage | A Python subset (see the implementation log), now including classes, objects, methods, properties and `pd.read_csv` on project CSV files. Not simulated: `try`/`with`, comprehensions, lambdas, f-strings, slicing, `*args`/`**kwargs`, most decorators (only `@property` and `@staticmethod`), async, multiple inheritance or inheriting from library classes, dict/set methods, list mutation (`append`…), file writes, other file formats and most library calls. These stop the run with an explicit *Unsupported* step | Phase 3+ |
| DataFrame model | Only simple CSVs (comma separated, header row) up to 2,000 rows, default index, and the operations listed in the log. `read_csv` options other than `sep=','` are not modelled | Phase 3+ |
| Tree-sitter | The Python AST adapter uses the Lezer grammar. Tree-sitter WASM evaluation has not been done yet | Phase 3 |
| Coverage report | Unsupported constructs are reported per run, not yet as per-file coverage statistics | Phase 3 |
| Large functions | Steps are not yet grouped into chapters | Phase 3 |
| ZIP import | Disabled on the start page. Only the bundled demo project can be opened | Phase 4 |
| File previews | Images, SVG, CSV tables, notebook cells and JSON/YAML trees are not rendered. Text formats show as source; images and unknown types show metadata only | Phase 4 |
| Cross-file navigation | The call map and the simulation follow resolvable calls across files. Clicking a call inside the code panel is not wired yet | Phase 5 |
| Dependency / asset explorers | None | Phase 5 |
| Persistent projects | None. Only UI preferences are stored (localStorage) | Phase 6 |
| Large files | Whole file loaded into the viewer. No size limits or virtualised loading yet | Phase 7 |
| End-to-end tests / deployment | Unit and component tests only; not deployed | Phase 8 |

## Known caveats in what exists

- **Simulation is a model, not Python.** Results are labelled *Simulated*. NumPy/pandas printing is approximated (flagged on the step). `round(x, n)` is approximated. Integers beyond 2^53 stop the run rather than lose precision.
- **Parser precedence.** Lezer groups unparenthesised `not a or b` as `not (a or b)`. Such expressions are refused, with a reason, rather than simulated wrongly.
- **Call map resolution** is static and conservative. Dynamic dispatch, reflection, `getattr`, decorators and runtime imports are not resolved. They appear as *unresolved* or *inferred*, or are missing entirely.
- **Simulation runs on the main thread.** That's fine for small scripts, but it should move to a Web Worker for large projects (Phase 7).
- **3D accessibility.** Screen readers treat the 3D canvas as a single image with a summary. The same facts are in the step card, the Explain panel and the 2D view.
- **3D visual check.** Label layout was verified programmatically at every step of both examples. A full visual review of the animation in a visible browser window is still pending (see the implementation log).
- **Outline parser.** Lezer is an error-recovering parser. On malformed code it may produce a partial outline. The UI reports the number of recovered regions so this is never silent.
- **Line endings.** CodeMirror shows CRLF files line by line like LF files. The original bytes are untouched, but the viewer doesn't show which line-ending style a file uses.
- **Byte sizes of demo files** are computed from their UTF-8 text. That is exact for the bundled text files. Real imports (Phase 4) will use archive byte counts.
- **File-type detection** uses names/extensions only. Content sniffing against MIME spoofing comes with ZIP import (Phase 4).
- **Explorer accessibility.** The tree uses `role="tree"` with buttons but no roving-tabindex arrow-key navigation yet.
- **Dev-dependency audit.** `npm audit` reports a high-severity ReDoS advisory in `picomatch`, pulled in by Vite and Vitest (build and test tooling only, not shipped to browsers). The only automatic fix downgrades Vite to 6.x, which was not applied. Revisit when upstream releases a patched version.
