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
