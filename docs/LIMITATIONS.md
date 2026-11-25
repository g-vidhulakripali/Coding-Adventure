# Outstanding limitations

Updated after importing real projects (2026-11-25). Each item names the phase expected to address it.

## Not implemented yet

| Area | Current state | Planned |
|---|---|---|
| Simulation coverage | All Python statements are read, and most are simulated. Never computed: files, network, clocks, random numbers, scikit-learn / SciPy / plotting, matrices (2-D arrays), bytes, generators that are iterated, `await`, class decorators other than `@dataclass`. Their results show as `?` and the run continues | Phase 3+ |
| DataFrame model | CSVs up to 2,000 rows; columns, masks, `.loc`, `.iloc`, reductions and simple column maths. `groupby`, `merge`, dates and multi-row indexes show as `?` | Phase 3+ |
| Tree-sitter | The Python AST adapter uses the Lezer grammar. Tree-sitter WASM evaluation has not been done yet | Phase 3 |
| Coverage report | Unsupported constructs are reported per run, not yet as per-file coverage statistics | Phase 3 |
| Large functions | Steps are not yet grouped into chapters | Phase 3 |
| Import | Folders and ZIPs up to 1 GB, 20,000 files, 100 MB per stored file. Tested by hand with a 46-file project and small test archives, **not** with archives near the limits. ZIP reading runs on the main thread | Phase 4 |
| File previews | Images, SVG, CSV tables, notebook cells and JSON/YAML trees are not rendered. Text formats show as source; images and unknown types show metadata only | Phase 4 |
| Cross-file navigation | The call map and the simulation follow resolvable calls across files. Clicking a call inside the code panel is not wired yet | Phase 5 |
| Dependency / asset explorers | None | Phase 5 |
| Persistent projects | Saved in IndexedDB. Analysis results are not saved: they are recomputed on opening (about 1.6 s for 45 Python files). The browser may delete saved data when the disk is full unless it grants persistence | Phase 6 |
| Large files | Text files over 5 MB are not shown; Python files over 2 MB and CSV files over 2 MB are kept but not analysed (listed under “left out”) | Phase 7 |
| End-to-end tests / deployment | Unit and component tests only; not deployed | Phase 8 |

## Known caveats in what exists

- **Simulation is a model, not Python.** Results are labelled *Simulated*. NumPy/pandas printing is approximated (flagged on the step). `round(x, n)` is approximated. Integers beyond 2^53 stop the run rather than lose precision.
- **Assumptions.** When a condition is `?`, the run assumes an answer (shown as *Inferred*, listed under “About this run”, switchable on its line). A loop over `?` is walked once, and everything it changed becomes `?` afterwards. Values computed **after** an assumed decision keep the label *Simulated*; they hold only if the assumption does. An error reached after an assumption is shown as “maybe an error”.
- **Calls that are not computed** are assumed to succeed and not to change the objects passed to them (well-known in-place methods excepted). Code inside `try` therefore never fails because of them.
- **Decorators** such as `lru_cache` and `st.cache_data` are ignored. Functions with other decorators can be run by themselves, but calls to them show as `?`.
- **Setup code** of imported files runs without showing its steps. Runs stop at 5,000 steps.
- **Sums of floats.** NumPy and pandas may add in a different order, so the last digit of a float sum, mean or spread can differ from the simulation.
- **Call map resolution** is static and conservative. Dynamic dispatch, reflection, `getattr`, decorators and runtime imports are not resolved. They appear as *unresolved* or *inferred*, or are missing entirely.
- **Simulation runs on the main thread.** That's fine for small scripts, but it should move to a Web Worker for large projects (Phase 7). Parsing and the call index already run in short slices.
- **3D accessibility.** Screen readers treat the 3D canvas as a single image with a summary. The same facts are in the step card, the Explain panel and the 2D view.
- **3D visual check.** Label layout was verified programmatically at every step of both examples. A full visual review of the animation in a visible browser window is still pending (see the implementation log).
- **Outline parser.** Lezer is an error-recovering parser. On malformed code it may produce a partial outline. The UI reports the number of recovered regions so this is never silent.
- **Line endings.** CodeMirror shows CRLF files line by line like LF files. The original bytes are untouched, but the viewer doesn't show which line-ending style a file uses.
- **Left-out folders.** `.git`, `.venv*`, `node_modules`, `__pycache__` and similar are not imported. Their files are counted when the browser lists them (ZIP); folders chosen directly are named but not opened.
- **File-type detection** uses names/extensions. Content is checked before it is shown as text: binary data under a text name is refused. No SVG or HTML is ever rendered.
- **Explorer accessibility.** The tree uses `role="tree"` with buttons but no roving-tabindex arrow-key navigation yet.
- **Dev-dependency audit.** `npm audit` reports a high-severity ReDoS advisory in `picomatch`, pulled in by Vite and Vitest (build and test tooling only, not shipped to browsers). The only automatic fix downgrades Vite to 6.x, which was not applied. Revisit when upstream releases a patched version.
