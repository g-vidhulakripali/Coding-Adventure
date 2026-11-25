import { Compartment, EditorState, type StateEffect } from '@codemirror/state';
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import type { ViewerLanguage } from '../../core/repository/fileTypes';
import { highlightField, linkField, loadLanguage, playgroundSyntax, playgroundTheme, setHighlight, setLinks, type CodeLink, type ViewerHighlight } from './codemirrorSetup';
import './CodeViewer.css';

export interface CodeViewerProps {
  /** Original file path — used to reset the view per file. */
  readonly path: string;
  /** Original, unmodified file text. */
  readonly content: string;
  readonly language: ViewerLanguage | null;
  readonly highlight: ViewerHighlight | null;
  /** Called when the user clicks a line number. */
  readonly onLineClick?: (line: number) => void;
  /** Places in this file that lead to a definition; Ctrl/Cmd-click (or click on a link) follows them. */
  readonly links?: readonly CodeLink[];
  readonly onFollow?: (line: number, column: number) => void;
}

/**
 * Read-only CodeMirror 6 viewer for ORIGINAL source text.
 *
 * The document is never edited: `EditorState.readOnly` blocks changes while
 * still allowing selection, copy and keyboard navigation.
 */
export function CodeViewer({ path, content, language, highlight, onLineClick, links, onFollow }: CodeViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const languageSlot = useRef(new Compartment());
  const lineClick = useRef(onLineClick);
  lineClick.current = onLineClick;
  const follow = useRef(onFollow);
  follow.current = onFollow;
  const latestHighlight = useRef(highlight);
  latestHighlight.current = highlight;

  // Create the editor once.
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({ parent: host.current });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  // New file → fresh state (no history or selection leaks between files).
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const slot = languageSlot.current;
    editor.setState(
      EditorState.create({
        doc: content,
        extensions: [
          lineNumbers({
            domEventHandlers: {
              mousedown(v, block) {
                lineClick.current?.(v.state.doc.lineAt(block.from).number);
                return true;
              },
            },
          }),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          EditorState.readOnly.of(true),
          EditorState.tabSize.of(4),
          EditorView.contentAttributes.of({ 'aria-label': `Source of ${path}`, 'aria-readonly': 'true' }),
          playgroundTheme,
          playgroundSyntax,
          highlightField,
          linkField,
          EditorView.domEventHandlers({
            mousedown(e, v) {
              if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return false;
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos === null) return false;
              const line = v.state.doc.lineAt(pos);
              follow.current?.(line.number, pos - line.from);
              e.preventDefault();
              return true;
            },
          }),
          keymap.of([
            {
              key: 'F12',
              run(v) {
                const line = v.state.doc.lineAt(v.state.selection.main.head);
                follow.current?.(line.number, v.state.selection.main.head - line.from);
                return true;
              },
            },
          ]),
          slot.of([]),
        ],
      }),
    );
    applyHighlight(editor, latestHighlight.current, 'center');

    let cancelled = false;
    loadLanguage(language).then((ext) => {
      if (!cancelled && view.current === editor) {
        editor.dispatch({ effects: slot.reconfigure(ext) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [path, content, language]);

  // Underline what can be followed.
  useEffect(() => {
    view.current?.dispatch({ effects: setLinks.of(links ?? []) });
  }, [links, path, content]);

  // Highlight changes within the same file.
  const highlightKey = highlight
    ? `${highlight.startLine}:${highlight.endLine}:${highlight.startColumn ?? ''}:${highlight.endColumn ?? ''}`
    : '';
  useEffect(() => {
    const editor = view.current;
    if (editor) applyHighlight(editor, latestHighlight.current, 'nearest');
  }, [highlightKey]);

  return <div className="code-viewer" ref={host} />;
}

function applyHighlight(editor: EditorView, highlight: ViewerHighlight | null, scroll: 'center' | 'nearest') {
  const effects: StateEffect<unknown>[] = [setHighlight.of(highlight)];
  if (highlight) {
    const doc = editor.state.doc;
    const line = doc.line(Math.min(Math.max(highlight.startLine, 1), doc.lines));
    effects.push(EditorView.scrollIntoView(line.from, { y: scroll, yMargin: 48 }));
  }
  editor.dispatch({ effects });
}
