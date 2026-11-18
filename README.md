# Code Playground

A browser-based application for understanding unfamiliar code repositories through interactive, source-linked visual explanations.

- Runs entirely in the browser. Repositories are never uploaded anywhere.
- Never executes uploaded code. Analysis is deterministic and static; simulations are controlled JavaScript models, labelled as such.
- No AI models or AI APIs.
- Deploys as a static website.

> **Status: Phase 1 (Foundation) complete.** The workspace, file explorer, code viewer and design system work against a bundled sample repository. The visual laboratory, Python analysis, ZIP import and persistent storage are later phases. See [docs/IMPLEMENTATION_LOG.md](docs/IMPLEMENTATION_LOG.md) and [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

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
| Open the sample | **Open sample** on the start page |
| Switch layout | Header layout buttons, or <kbd>Alt</kbd>+<kbd>1</kbd> Code + Lab + Explain · <kbd>2</kbd> Code + Lab · <kbd>3</kbd> Code only · <kbd>4</kbd> Lab only |
| Show / hide files | Sidebar button in the header |
| Resize panels | Drag a divider, or focus it and press <kbd>←</kbd>/<kbd>→</kbd>. Double-click to reset |
| Jump to a function or class | **Outline** under the file tree |
| Highlight a line | Click its line number. The URL updates, so you can share the link |
| Collapse the explanation | Chevron in the Explain header |
| Theme | Header button cycles system → light → dark |

Deep links look like `#/project/sample?file=analysis/usage.py&line=25-29`.

## Project structure

```text
src/
├── app/                 App shell, hash router, routes (Home, Workspace)
├── components/
│   ├── layout/          Header, panels, resizable row, layout modes
│   ├── code-editor/     CodeMirror 6 viewer, source highlight, outline list
│   ├── file-explorer/   Repository tree, filter, sidebar
│   ├── visual-lab/      Visual laboratory (Phase 1: empty state + visual vocabulary)
│   ├── explanation/     Explanation panel, evidence badges
│   └── common/          Inline SVG icon set
├── core/
│   ├── repository/      ORIGINAL repository model, file-type detection, tree building
│   ├── source-mapping/  SourceSpan / LineRange types shared by every layer
│   ├── analysis/        Evidence levels (verified / static / inferred / simulated / unsupported)
│   ├── parser/          File outline (Phase 1: Lezer; Phase 3: Tree-sitter evaluation)
│   └── project/         Project registry (where ProjectSources come from)
├── demo/                Bundled sample repository, kept separate from real analysis
├── hooks/               Theme, media query, persisted preferences
├── styles/              Design tokens and global styles
└── utils/               Guarded localStorage access for UI preferences
```
