import type { OutlineSymbol } from '../../core/parser/outline';
import type { LineRange } from '../../core/source-mapping/types';
import { Icon } from '../common/Icon';
import './OutlineList.css';

export interface OutlineListProps {
  readonly symbols: readonly OutlineSymbol[];
  readonly activeLines: LineRange | null;
  readonly onSelect: (symbol: OutlineSymbol) => void;
}

/** Function / class / method navigation for the current file. */
export function OutlineList({ symbols, activeLines, onSelect }: OutlineListProps) {
  if (symbols.length === 0) {
    return <p className="outline__empty">No functions or classes in this file.</p>;
  }
  return (
    <ul className="outline" aria-label="Functions and classes">
      {symbols.map((s) => (
        <OutlineItem key={`${s.kind}:${s.name}:${s.line}`} symbol={s} depth={0} activeLines={activeLines} onSelect={onSelect} />
      ))}
    </ul>
  );
}

function OutlineItem({
  symbol,
  depth,
  activeLines,
  onSelect,
}: {
  symbol: OutlineSymbol;
  depth: number;
  activeLines: LineRange | null;
  onSelect: (symbol: OutlineSymbol) => void;
}) {
  const active =
    activeLines !== null &&
    activeLines.startLine === symbol.range.startLine &&
    activeLines.endLine === symbol.range.endLine;
  const kindLabel = symbol.kind === 'class' ? 'class' : `${symbol.isAsync ? 'async ' : ''}${symbol.kind}`;
  return (
    <li>
      <button
        type="button"
        className={`outline__row outline__row--${symbol.kind}`}
        style={{ paddingLeft: `${10 + depth * 14}px` }}
        aria-current={active ? 'location' : undefined}
        onClick={() => onSelect(symbol)}
        title={`${kindLabel} ${symbol.name} — lines ${symbol.range.startLine}–${symbol.range.endLine}`}
      >
        <Icon name={symbol.kind === 'class' ? 'symbolClass' : 'symbolFunction'} className="outline__icon" />
        <span className="outline__name">
          {symbol.name}
          {symbol.kind !== 'class' ? <span className="outline__parens">()</span> : null}
        </span>
        {symbol.isAsync ? <span className="outline__tag">async</span> : null}
        {symbol.decorated ? <span className="outline__tag">@</span> : null}
        <span className="outline__line">L{symbol.line}</span>
      </button>
      {symbol.children.length > 0 ? (
        <ul className="outline">
          {symbol.children.map((c) => (
            <OutlineItem key={`${c.kind}:${c.name}:${c.line}`} symbol={c} depth={depth + 1} activeLines={activeLines} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
