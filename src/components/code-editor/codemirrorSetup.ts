import { python } from '@codemirror/lang-python';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { ViewerLanguage } from '../../core/repository/fileTypes';

/* ------------------------------------------------------------------------ */
/* Theme — all colours come from design tokens, so light/dark just works.   */
/* ------------------------------------------------------------------------ */

export const playgroundTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--code-bg)',
    color: 'var(--color-text)',
    fontSize: 'var(--code-font-size)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
  },
  '.cm-content': { padding: '8px 0 40vh' },
  '.cm-gutters': {
    backgroundColor: 'var(--code-gutter-bg)',
    color: 'var(--code-gutter-text)',
    border: 'none',
    borderRight: '1px solid var(--color-border)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 12px 0 16px',
    cursor: 'pointer',
  },
  '.cm-lineNumbers .cm-gutterElement:hover': { color: 'var(--color-accent)' },
  '.cm-activeLine': { backgroundColor: 'var(--code-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-text-muted)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--code-selection) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--color-accent)' },
  // Source highlight driven by navigation / the visual laboratory.
  '.cm-cp-highlight-line': {
    backgroundColor: 'var(--code-highlight-line)',
    boxShadow: 'inset 3px 0 0 var(--code-highlight-edge)',
  },
  '.cm-cp-link': { textDecoration: 'underline dotted var(--color-text-faint)', textUnderlineOffset: '3px' },
  '.cm-cp-highlight-mark': {
    backgroundColor: 'var(--code-highlight-mark)',
    borderRadius: '3px',
    outline: '1px solid var(--code-highlight-edge)',
  },
});

export const playgroundHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: [t.function(t.definition(t.variableName)), t.definition(t.className)], color: 'var(--syn-def)', fontWeight: '600' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-def)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.standard(t.variableName), t.self, t.className], color: 'var(--syn-builtin)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--syn-operator)' },
  { tag: [t.meta, t.annotation], color: 'var(--syn-decorator)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-property)' },
  { tag: [t.heading], color: 'var(--syn-def)', fontWeight: '700' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '700' },
  { tag: [t.link, t.url], color: 'var(--syn-builtin)', textDecoration: 'underline' },
  { tag: [t.invalid], color: 'var(--syn-invalid)' },
]);

export const playgroundSyntax: Extension = syntaxHighlighting(playgroundHighlightStyle);

/* ------------------------------------------------------------------------ */
/* Source highlight: lines, optionally with an exact expression range.      */
/* ------------------------------------------------------------------------ */

export interface ViewerHighlight {
  readonly startLine: number;
  readonly endLine: number;
  /** 0-based column range on startLine / endLine for an exact expression. */
  readonly startColumn?: number;
  readonly endColumn?: number;
}

export const setHighlight = StateEffect.define<ViewerHighlight | null>();

const lineDeco = Decoration.line({ class: 'cm-cp-highlight-line' });
const markDeco = Decoration.mark({ class: 'cm-cp-highlight-mark' });

export const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setHighlight)) continue;
      const h = effect.value;
      if (!h) {
        next = Decoration.none;
        continue;
      }
      const doc = tr.state.doc;
      const start = clamp(h.startLine, 1, doc.lines);
      const end = clamp(h.endLine, start, doc.lines);
      const builder = new RangeSetBuilder<Decoration>();
      const hasColumns = h.startColumn !== undefined && h.endColumn !== undefined;
      for (let n = start; n <= end; n++) {
        const line = doc.line(n);
        builder.add(line.from, line.from, lineDeco);
        if (hasColumns) {
          const from = n === start ? Math.min(line.from + h.startColumn!, line.to) : line.from;
          const to = n === end ? Math.min(line.from + h.endColumn!, line.to) : line.to;
          if (to > from) builder.add(from, to, markDeco);
        }
      }
      next = builder.finish();
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/* ------------------------------------------------------------------------ */
/* Links: names that lead to a definition in the project.                   */
/* ------------------------------------------------------------------------ */

export interface CodeLink {
  readonly line: number;
  readonly from: number;
  readonly to: number;
  readonly title: string;
}

export const setLinks = StateEffect.define<readonly CodeLink[]>();

export const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setLinks)) continue;
      const doc = tr.state.doc;
      const marks = effect.value
        .filter((l) => l.line >= 1 && l.line <= doc.lines)
        .map((l) => {
          const line = doc.line(l.line);
          return { from: Math.min(line.from + l.from, line.to), to: Math.min(line.from + l.to, line.to), title: l.title };
        })
        .filter((m) => m.to > m.from);
      next = Decoration.set(
        marks.map((m) => Decoration.mark({ class: 'cm-cp-link', attributes: { title: m.title } }).range(m.from, m.to)),
        true,
      );
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/* ------------------------------------------------------------------------ */
/* Python is always needed (the outline uses its grammar); other languages  */
/* are loaded on demand so unused grammars never hit the initial bundle.    */
/* ------------------------------------------------------------------------ */

export async function loadLanguage(language: ViewerLanguage | null): Promise<Extension> {
  switch (language) {
    case 'python':
      return python();
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml();
    default:
      return [];
  }
}
