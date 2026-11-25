# Code Playground

A browser-based application for understanding unfamiliar code repositories through interactive, source-linked visual explanations.

- Runs entirely in the browser. Repositories are never uploaded anywhere.
- Never executes uploaded code. Analysis is deterministic and static; simulations are controlled JavaScript models, labelled as such.
- No AI models or AI APIs.
- Deploys as a static website.

> **Status: Phase 2 (interactive visual laboratory) complete**, plus a static call map, and importing your own folders and ZIPs, saved in the browser. You can step through Python code line by line (or on a 3D bench), edit inputs, and follow values across files, with every step tied to its exact source. What cannot be computed shows as `?`, never as a guess. File previews and full Tree-sitter analysis are later phases. See [docs/IMPLEMENTATION_LOG.md](docs/IMPLEMENTATION_LOG.md) and [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Getting started

Requires Node.js 20.19+ (developed on Node 22).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit + component tests (Vitest, jsdom)
npm run typecheck  # TypeScript project build
npm run build      # static production build in dist/
npm run preview    # serve dist/ locally
```

The `dist/` folder uses relative asset paths and hash routing, so it can be served from any static host or sub-path (GitHub Pages, Netlify, Cloudflare Pages) without server rewrites.

## Using the workspace

| Action | How |
|---|---|
| Open your project | **choose folder** or **choose ZIP** on the start page, or drop it there |
| Open it again | **Saved projects** on the start page |
| Open the sample | **Open sample** on the start page |
| Run one function | Click it in the **Outline**. Values you do not give stay `?` |
| Skip over calls | <kbd>↓</kbd>, or the ⤵ button |
| Switch an assumed answer | The **yes / no** buttons on its line |
| Switch layout | Header layout buttons, or <kbd>Alt</kbd>+<kbd>1</kbd> Code + Lab + Explain · <kbd>2</kbd> Code + Lab · <kbd>3</kbd> Code only · <kbd>4</kbd> Lab only |
| Show / hide files | Sidebar button in the header |
| Resize panels | Drag a divider, or focus it and press <kbd>←</kbd>/<kbd>→</kbd>. Double-click to reset |
| Jump to a function or class | **Outline** under the file tree |
| Highlight a line | Click its line number. The URL updates, so you can share the link |
| Collapse the explanation | Chevron in the Explain header |
| Theme | Header button cycles system → light → dark (dark is the default) |
| Simulate code | **Visual Lab → simulation**: pick a script or function, then step with <kbd>←</kbd>/<kbd>→</kbd>, play/pause with <kbd>Space</kbd> |
| Change inputs | Edit the literal values under **Inputs** (or **Arguments** for a function) and press <kbd>Enter</kbd> |
| 3D / 2D | Toggle in the Visual Lab header. 2D is used automatically without WebGL or with reduced motion |
| See who calls what | **Visual Lab → call map**: click a function for its call sites; click a location to open it |

Deep links look like `#/project/sample?file=analysis/usage.py&line=25-29`.

## Project structure

```text
src/
├── app/                 App shell, hash router, routes (Home, Workspace)
├── components/
│   ├── layout/          Header, panels, resizable row, layout modes
│   ├── code-editor/     CodeMirror 6 viewer, source highlight, outline list
│   ├── import/          Import card, saved projects
│   ├── file-explorer/   Repository tree, filter, sidebar
│   ├── visual-lab/      Simulation controller, 3D stage (three/), 2D stage, step card, call map
│   ├── explanation/     Explanation panel, evidence badges
│   └── common/          Inline SVG icon set
├── core/
│   ├── repository/      ORIGINAL repository model, file-type detection, tree building
│   ├── source-mapping/  SourceSpan / LineRange types shared by every layer
│   ├── analysis/        Evidence levels; python/callIndex.ts (static call index)
│   ├── parser/          Outline + python/ast.ts (Python AST adapter with exact spans)
│   ├── simulation/      Deterministic JS model of a Python subset (+ pandas/NumPy subset)
│   ├── visualisation/   Renderer-independent scene model, call-map layout
│   ├── import/          Folder / ZIP reading, safety checks, limits
│   └── project/         Project registry, saved projects (IndexedDB)
├── demo/                Bundled sample repository, kept separate from real analysis
├── hooks/               Theme, media query, persisted preferences
├── styles/              Design tokens and global styles
└── utils/               Guarded localStorage access for UI preferences
```
