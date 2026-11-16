import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { foldGutter, foldKeymap, syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
export function createEditor(element, onChange, names) {
  const permission = new Compartment(); let replacing = false;
  const extensions = [lineNumbers(), history(), drawSelection(), highlightActiveLine(), markdown(), foldGutter(), bracketMatching(), highlightSelectionMatches(), syntaxHighlighting(defaultHighlightStyle), oneDark, EditorView.lineWrapping,
    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap]),
    permission.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
    EditorView.contentAttributes.of({ 'aria-label': 'Editor Markdown', spellcheck: 'false' }),
    autocompletion({ override: [context => { const match = context.matchBefore(/\[\[[^\]\n]*/); if (!match) return null; return { from: match.from + 2, options: names().slice(0, 3000).map(label => ({ label, type: 'text', apply: label + ']]' })) }; }] }),
    EditorView.updateListener.of(update => { if (update.docChanged && !replacing) onChange(update.state.doc.toString()); })];
  const view = new EditorView({ parent: element, state: EditorState.create({ extensions }) });
  return {
    set(content, readOnly = false) { replacing = true; view.setState(EditorState.create({ doc: content, extensions })); view.dispatch({ effects: permission.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) }); replacing = false; },
    focus() { view.focus(); },
    line(number) { const line = view.state.doc.line(Math.min(Math.max(1, number), view.state.doc.lines)); view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) }); },
    get value() { return view.state.doc.toString(); }
  };
}
