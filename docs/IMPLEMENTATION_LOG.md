# Implementation log

## Phase 1: Foundation (2026-11-18)

### Environment

- Windows 11, Node 22.19, npm 10.9, Git 2.47.
- The repository was empty apart from a README. Branch: `dev`.

### Stack chosen

| Concern | Choice | Why |
|---|---|---|
| Framework | React 19 + TypeScript 7 (strict) | As specified. TS 7 is the current `latest` release. `noUncheckedIndexedAccess` is on |
| Build | Vite 8 | As specified. `base: './'` keeps the build host-agnostic |
| Code viewer | CodeMirror 6 (state, view, language, lang-python/json/markdown/yaml) | As specified. Modular and themeable, and it ships the Lezer Python parser |
| Routing | Custom hash router (~80 lines, `src/app/router.ts`) | Static hosting needs no rewrites. The app has three routes, so a routing library isn't worth adding |
| State | React state and context-free props, with persisted preferences in `localStorage` (guarded) | Not enough shared state yet to justify a store library |
| Panel resizing | Custom `ResizableRow` with pure, tested math | Small, accessible (`role="separator"`, arrow keys), no dependency |
| Icons | Inline SVG set | No icon library or icon font |
| Tests | Vitest 5 + jsdom + Testing Library | Shares the Vite config |

Not added: ESLint (strict `tsc` covers the essentials for now; to be revisited), state libraries, CSS frameworks, router libraries, and web fonts (system font stacks keep the app offline-capable and request-free).

### Key architecture decisions

1. **Two repository representations from day one.** `core/repository` is the original, lossless model (paths, names, sizes and categories are never rewritten). Analysis output will live in `core/analysis` and may be incomplete without ever affecting the original model.
2. **`ProjectSource` interface.** The workspace reads files only through `ProjectSource.readText()`. The demo implements it today. ZIP imports (Phase 4) and IndexedDB/OPFS-restored projects (Phase 6) will implement the same interface, so the UI won't change.
3. **Demo data is isolated.** `src/demo/` holds ordinary files that Vite inlines at build time. It is loaded lazily through the registry and labelled "demo" in the UI.
4. **Shared source-location currency.** `SourceSpan`/`LineRange` (1-based lines, 0-based UTF-16 columns) are defined now and used by the viewer highlight. The highlight extension already supports exact expression ranges (column marks) for Phase 2.
5. **Evidence levels are part of the core model.** `verified | static | inferred | simulated | unsupported`, each with a token colour. Simulated badges get a dashed outline so they never read as fact.
6. **Outline uses a real parser, not regex.** It uses the Lezer Python grammar that CodeMirror already loads. Syntax-error recovery is counted and shown to the user. Phase 3 evaluates Tree-sitter for full analysis; this stays as a lightweight fallback.
7. **Content is tagged with its path.** When you switch files, the previous file's text never appears under the new file's name, even for one render.
8. **Code splitting.** The workspace route (CodeMirror + Python grammar) is lazy-loaded. Markdown/JSON/YAML grammars load on demand. The home page is ~73 KB gzipped JS.

### What works (verified)

- Start page → **Open sample** → three-panel workspace (Files | Source | Visual Lab | Explain).
- File explorer: every file listed with original names and folder structure, category badges, an "unsupported" flag, recursive folder counts, path filter, and automatic reveal of the selected file.
- Code viewer: read-only CodeMirror, syntax highlighting (Python/JSON/Markdown/YAML), line numbers, active line, click-a-line-number to highlight and update the URL.
- Outline: functions, classes, methods, async and decorated definitions, nested functions, and definitions inside `if`/`try` blocks. Clicking highlights the full definition range and scrolls to it.
- Deep links (`?file=…&line=a-b`), a missing-file message, and a project-not-found page.
- Layout modes (four, via buttons or Alt+1–4), explorer toggle, collapsible explanation rail, resizable and persisted panel widths with double-click reset.
- Light / dark / system themes. Reduced-motion tokens. Phone-width layout with panel tabs and no horizontal page scroll.
- Explanation panel shows only provable facts (path, type, size and line count marked *Verified source*; outline counts marked *Static analysis*), plus the evidence legend.

Verification: `npm test` (56 tests, 6 files), `npm run build` (clean, no warnings), and manual checks in a browser at 1440×900 and 375×812, light and dark, with no console errors.

### Bugs found and fixed during verification

- A deep link to a non-existent file showed "No file selected". It now says the file is not in the project.
- Collapsing the explanation panel left an empty strip on the right: CSS flex only distributes a fraction of free space when grow factors sum to less than 1. Grow factors are now normalised.

## Coder theme (2026-11-18)

Requested after Phase 1: the UI was restyled as a code-editor / terminal theme.

- Dark IDE palette is now the default (light remains available). A small inline script applies the saved theme before first paint, so there is no light flash.
- UI chrome (titles, buttons, labels, file tree, outline) uses the monospace face. Longer explanatory text stays sans-serif for readability.
- Start page: an editor-window hero with line numbers and a blinking cursor, a `$ code-playground --check` terminal list of the privacy guarantees, and file-tab cards.
- New `>_` logo and favicon.

## Phase 2: Interactive visual laboratory (2026-11-18)

Requested additions: the lab is **3D by default**, and there is a separate **call map** showing what each function calls and where it is called from.

### Approach

No Python is executed. A small deterministic JavaScript model walks the parsed syntax tree and records one step per meaningful operation. Each step carries its exact source span, inputs (with the step that produced each one), output, destination, call-stack snapshot and a plain-language explanation. Anything outside the model stops the run with an explicit *Unsupported* step rather than a guess.

| Layer | Files | Notes |
|---|---|---|
| Python AST adapter | `core/parser/python/ast.ts` | Parser-independent AST with exact offsets, built from the Lezer grammar. Phase 3 can add a Tree-sitter adapter producing the same shapes. It rebuilds chained comparisons and refuses ambiguous unparenthesised `not … or …` (a Lezer precedence quirk) instead of simulating it wrongly. |
| Simulation | `core/simulation/*` | Values, Python-faithful formatting (`25.0`, `1e+16`, CPython error wording), operators, and built-ins (`print`, `sum`, `len`, `float`, `int`, `str`, `bool`, `abs`, `round`, `min`, `max`, `range`, `list`, `tuple`, `sorted`). Imports between project files, user functions, `if`/`elif`/`else`, `for`, `while`, `return` and tuple unpacking. A pandas/NumPy subset: `pd.Series`, `np.array`, `.iloc[]`, `.to_numpy(dtype=)`, `.values`, `.sum/.mean/.max/.min/.tolist`, and 1-D indexing with NumPy's bounds and type rules. Limits on steps, call depth and loop iterations. |
| Inputs | `core/simulation/scenarios.ts`, `literal.ts` | Runnable scenarios come from the syntax tree: scripts (files with top-level code) and plain functions (run with arguments you enter). Editable inputs are the literal values assigned at module level, including inside `if __name__ == "__main__":`, and literal arguments such as `pd.Series([…])`. User input goes through a literal-only parser; nothing is evaluated. |
| Scene model | `core/visualisation/scene.ts` | Renderer-independent: frames (call stack), variables, operation, tokens with their sources, destination. |
| 3D lab | `components/visual-lab/three/LabRenderer.ts` | Plain Three.js, lazy-loaded. Each call-stack frame is a bench (callers recede behind it, dimmed). Variables are glass containers, and collections show one cube per element with its index. The operation "machine" changes shape and colour by role. Values fly as tokens from their source to the machine and on to their destination. Text is HTML pinned to 3D positions, so it stays crisp and themed. The scene renders on demand only. The camera is fitted by projecting the bench corners and labels into the stage. Console output is a screen-space terminal overlay. |
| 2D fallback | `components/visual-lab/Stage2D.tsx` | The same scene in HTML/CSS. Used automatically without WebGL or with `prefers-reduced-motion`; also selectable. |
| Step card | `components/visual-lab/StepCard.tsx` | For every operation: exact code and location, inputs (with "from step N"), what happens, output, and where it goes next ("used by step N"). |
| Explain panel | `components/explanation/SimulationExplanation.tsx` | What / why / in / out / next, a variables table per frame with types, console output, and run notes (assumptions, stop reason, statements not shown as steps). |
| Source sync | `app/routes/WorkspaceRoute.tsx` | Once you step through the simulation, the code panel follows execution, switching files when a call enters another module, and highlights the exact expression. |
| Call map | `core/analysis/python/callIndex.ts`, `core/visualisation/callMapLayout.ts`, `components/visual-lab/CallMap.tsx` | A static index of definitions and calls across all Python files. Calls are resolved through same-file definitions and explicit imports (*static*); `self.method()` is marked *inferred*; unknown receivers are marked *unresolved*; built-ins and library calls are labelled. The layered SVG graph supports pan and zoom, and the details panel lists "called from" and "calls" with clickable source locations. |

### Validation

- **Example 1 (shopping calculator)**: all 12 required facts appear in order, across `main.py` and `pricing.py`, with exact expression highlighting: `sum(prices)` gives 25.0, `subtotal * discount` gives 2.5, `subtotal - discount_amount` gives 22.5, `return` goes back to `main.py`, and `print` shows 22.5. Editing the prices to `[10, 20, 30, 40]` and the discount to `0.25` replays to `subtotal = 100` (an `int`, as in Python) and `75.0`.
- **Example 2 (`hours_usage` expression)**: follows Python's real evaluation order. `hours_usage.to_numpy(dtype=float)` runs first, then `stationary.iloc[0]` gives `2` (`numpy.int64`), then `[…]` selects position 2, giving `30.5` (`numpy.float64`), then `float(...)` gives `30.5`, then `result`, then return and print. (The prompt's list explains `iloc[0]` first; Python evaluates the array before the index, and the simulation follows Python.) Changing `stationary` to `[5, 0, 1]` stops with NumPy's `IndexError: index 5 is out of bounds for axis 0 with size 3`, with the call stack visible at the failure point.
- Tests: 92 passing (engine, AST, call index, scene model, call-map layout, UI units). The production build is clean.
- Browser: both examples were stepped end to end in the running app (code-panel file switching, exact highlights, input edits, the error case, the call map, the 2D view). The 3D label layout was checked programmatically at every step of both examples (no overlapping labels, everything inside the stage) in a 455 px-wide lab panel.
- **Not yet done:** watching the 3D animation itself. The browser pane was hidden during this session, so the page could not run animation frames or produce live screenshots.

### Bugs found and fixed during verification

- The default scenario could pick an unrelated script. It now prefers the script that calls into the open file (from the call index), then conventional entry-point names.
- Error steps were recorded after the call stack unwound, so the variables at the failure point were missing. They are now recorded at the failure point.
- `self.method()` calls lost their class context inside method bodies, so they could not be resolved.
- 3D: a fixed-width bench and camera did not fit narrow panels, labels collided, and the stage height jumped between steps. Fixed with content-sized benches, projection-based camera fitting, staggered name tags, a console overlay and a stable step-card height.

### Phase 2 iteration: make it understandable for a child (2026-11-18)

Feedback: the animation was hard to follow, words overlapped, the light theme looked washed out, and the stage should show numbers rather than words, line by line, with calls opening the called function.

- **Lines view (now the default):** the running function or file is a container of its own source lines. The current line is lit, finished lines show results as number chips (`= 2.5`, `↩ 22.5`), and unrun lines are faded. A call opens the called function's container, and the caller waits above as a one-line card. `if`/`elif`/`else` is a container with the taken branch lit and the others skipped; loops show an item counter; a class is one big container listing its methods. (`core/visualisation/lines.ts`, `components/visual-lab/Stage2D.tsx`)
- **Numbers that move:** the current line shows a picture-sum (e.g. `12.0 + 8.0 + 5.0 = 25.0`). Numbers fly out of their boxes into it, the answer pops in, and stored values fly into their box.
- **Minimal words on the stage:** an icon plus a one-to-three-word label. The full plain-language sentence ("Add up all the numbers in prices… Next, 25.0 goes into the box called subtotal.") is the first line of the step card. (`core/visualisation/story.ts`)
- **3D bench (still available):** steeper top-down camera, spotlight on the boxes in use, no text on waiting benches, no code text on the stage, an after-render pass that nudges colliding labels, and theme-aware bench/glass colours for light mode. With every label counted, there are no overlaps at a 1558×787 window in light and dark. Below about 560 px of Lab height the Lines view is used, because 3D labels cannot fit.
- **Lab layout:** step details and inputs share one tabbed dock (collapsed by default when space is short), inputs are one compact row each, and playback is always visible.

### Classes, methods and CSV data (2026-11-20)

Requested: show a class as one big container, open only the method being called (line by line), let the user create their own values when there are none, and handle functions that read CSV files.

- **Classes and objects** (`core/simulation/interpreter.ts`): a class definition records its methods (plain, `@property`, `@staticmethod`; `async` methods are listed but not run) and simple class attributes. Single inheritance from project classes is supported. `Cls(...)` makes an object and runs `__init__`. `self.x = …` and `self.x += …` set fields. `obj.method()`, `self.method()` and properties open that method line by line. Objects live in a small store; each step records the fields as they were at that moment. Unknown attributes raise Python's `AttributeError` wording.
- **CSV files** (`core/simulation/csv.ts`, `libraries.ts`): `pd.read_csv("path")` reads the project's own CSV (data only) into a table model. Column types are inferred as pandas does (int64 / float64 / bool / object, empty → NaN). Supported table operations: `df["col"]`, `df[["a","b"]]`, `df.col`, `.head()`/`.tail()`, `.shape`, `.columns`, `.empty`, `len(df)`, column `.sum()/.mean()/.max()/.min()` (skipping NaN), and pandas-like printing. Relative paths are looked up from the repository root, then the script's folder (stated as an assumption). If the file is not in the project, the run stops with "needs data", and the inputs tab offers a box to type a few sample rows, which are then used.
- **Run a method with your own inputs** (`core/simulation/scenarios.ts`, `useSimulationController.ts`): the run picker lists "Use Class: method()" for each public method and property. The inputs tab has two groups, "make a Class" (`__init__` values, pre-filled from defaults such as `csv_path="data/usage.csv"`) and the method's own values.
- **Display**: objects are drawn as one container with their fields (in the boxes shelf and the picture-sums), and tables as small previews with the selected column highlighted. Method containers read "🧩 Class › method". Entering a function lights its header line while the values arrive. New plain-language stories: "new UsageReport", "read data/usage.csv", "column hours".
- Verified in the running app: "Use UsageReport: load()" makes the object, runs `__init__`, opens `load`, reads `data/usage.csv` (3 rows × 3 columns) into `self.frame` and returns it. Changing `csv_path` to a missing file stops with "needs data"; pasting two rows replays to the end with a 2×2 table. 112 tests pass.

### Importing and understanding a real project (2026-11-25)

Requested: import a full, large project and try to understand all of it. A private research project (45 Python files, 15,847 lines, 551 functions) was used to find out what real code needs. None of its code is in this repository; every test uses made-up code.

- **Import** (`core/import/*`, `components/import/*`): choose or drop a folder or a ZIP. Own ZIP reader (central directory, ZIP64, `DecompressionStream`), one entry at a time from disk. Checks: path traversal, absolute paths, control and text-direction characters, encryption, links, overlapping entries, unpacked/packed ratio, more data than declared, checksums, file count, sizes, nested archives kept closed. Every offered file is imported, listed without content, or named with the reason it was refused.
- **Saved projects** (`core/project/storage.ts`): IndexedDB, original bytes under original paths, with progress, cancel, a free-space check, and nothing half-imported on failure. Reopen or remove from the start page.
- **Reading all of Python** (`core/parser/python/ast.ts`): comprehensions, f-strings, lambdas, slices, `with`, `try`, `raise`, `assert`, `del`, starred arguments, `global`/`nonlocal`, walrus, `yield`. Line endings are made uniform in the analysis copy only, because the grammar reports false errors on some CRLF files.
- **Never stopping at an unknown** (`core/simulation/interpreter.ts`): what cannot be computed becomes a visible `?` with a reason, and the walk continues. A `?` is never turned into a value. Unknown conditions are assumed, marked and switchable; loops over unknown collections are walked once and everything they changed becomes `?`; comprehensions that depend on an unknown decision become `?`.
- **More that is computed**: lists, dictionaries and sets that change in place, text and container methods, sort keys, closures, exceptions, data classes, f-string formatting, and a wider NumPy / pandas / `math` / `os.path` model (`containers.ts`, `format.ts`, `numeric.ts`).
- **Any function runs at once**: arguments without a value are `?`. The code is read for how each parameter is used (`paramShapes.ts`): a table gets a CSV box with the columns the function really reads (also through constants such as `K.HEIGHT_COL`), a dictionary gets one box per key, and “try made-up numbers” fills them with labelled example values.
- **Finding the way in a large project**: choosing a function in the outline shows it in the Lab; opening a file outside the current run shows that file; “next line” skips calls (↓); the call map focuses on one function and its neighbours above 60 definitions; parsing and the call index run in slices.
- **Verified**: the real project imports in 0.2 s and is ready 1.6 s later. 507 runs (every function and method, with only their default arguments, plus one script): 475 reach the end, 8 stop at the step limit and 24 end in a Python error, all labelled as resting on an assumption; no view fails. Without inputs about a quarter of the results (35,915 of 143,943) are computed; the rest show as `?`. Reopening after a reload, removing, a file that is not a ZIP, a stand-in folder, light and dark themes were checked in the running app. The browser's own folder dialog cannot be driven by a test and was not.
- Tests: 156 passing; production build clean.
