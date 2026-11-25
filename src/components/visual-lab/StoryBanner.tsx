import type { Scene } from '../../core/visualisation/scene';
import type { Story, StoryTile } from '../../core/visualisation/story';
import './StoryBanner.css';

/**
 * The plain-language headline of a step plus its picture-sum. Shown on top of
 * the 3D lab and at the heart of the 2D view.
 */
export function StoryBanner({ story, variant = 'stage' }: { story: Story; variant?: 'stage' | 'inline' | 'row' }) {
  // On the stage, words are kept to a tiny label; the full sentence is read out by screen readers
  // and shown in the step card.
  return (
    <div className={`story story--${variant} is-${story.tone}`} aria-live="polite" aria-label={story.headline}>
      {variant === 'row' && story.tiles.length > 0 ? null : (
        <p className="story__headline">
          <span className="story__icon" aria-hidden="true">
            {story.icon}
          </span>
          {variant === 'inline' ? story.headline : story.label}
        </p>
      )}
      {story.tiles.length > 0 ? (
        <div className="story__tiles" aria-hidden="true">
          {story.tiles.map((tile, i) => (
            <Tile key={i} tile={tile} />
          ))}
        </div>
      ) : null}
      {story.next && variant === 'inline' ? <p className="story__next">{story.next}</p> : null}
    </div>
  );
}

function Tile({ tile }: { tile: StoryTile }) {
  switch (tile.kind) {
    case 'op':
      return (
        <span className="tile tile--op" data-kind="op">
          {tile.text}
        </span>
      );
    case 'value':
    case 'result':
      return (
        <span className={`tile tile--${tile.kind}`} data-kind={tile.kind} data-source={tile.kind === 'value' ? tile.source : undefined}>
          <b>{tile.text}</b>
          {tile.caption ? <small>{tile.caption}</small> : null}
        </span>
      );
    case 'box':
      return (
        <span className="tile tile--box" data-kind="box" data-target={tile.name}>
          <span className="tile__lid" aria-hidden="true" />
          <b>{tile.name}</b>
        </span>
      );
    case 'helper':
      return (
        <span className="tile tile--helper" data-kind="helper">
          <span aria-hidden="true">🧑‍🍳</span> <b>{tile.name}</b>
        </span>
      );
    case 'place':
      return (
        <span className="tile tile--place" data-kind="place">
          <span aria-hidden="true">{tile.icon}</span>
          {tile.text ? <b>{tile.text}</b> : null}
        </span>
      );
    case 'table':
      return (
        <span className="tile tile--table" data-kind="list" data-source={tile.source}>
          <MiniTable header={tile.header} rows={tile.rows} more={tile.more} highlight={tile.highlight} />
          {tile.caption ? <small>{tile.caption}</small> : null}
        </span>
      );
    case 'object':
      return (
        <span className="tile tile--object" data-kind="list" data-source={tile.source}>
          <span className="tile__objhead">
            <span aria-hidden="true">🧩</span> {tile.cls}
          </span>
          {tile.fields.length > 0 ? (
            <span className="tile__fields">
              {tile.fields.map(([k, v]) => (
                <span key={k}>
                  <small>{k}</small> <b>{v}</b>
                </span>
              ))}
            </span>
          ) : (
            <small>empty</small>
          )}
        </span>
      );
    case 'list':
      return (
        <span className="tile tile--list" data-kind="list" data-source={tile.source}>
          <span className="tile__items">
            {tile.items.map((item, i) => (
              <span key={i} className={i === tile.selected ? 'is-selected' : undefined}>
                <b>{item}</b>
                <small>{i}</small>
              </span>
            ))}
          </span>
          {tile.caption ? <small>{tile.caption}</small> : null}
        </span>
      );
  }
}

/** Where we are: the chain of files and helpers currently running. */
export function Trail({ scene }: { scene: Scene }) {
  return (
    <ol className="lab-trail" aria-label="Where we are">
      {scene.frames.map((f, i) => (
        <li key={f.id} className={i === scene.frames.length - 1 ? 'is-current' : undefined}>
          <span aria-hidden="true">{i === 0 ? '🏠 ' : '🧑‍🍳 '}</span>
          {f.kind === 'module' ? f.path : f.label.split(' · ')[0]}
        </li>
      ))}
    </ol>
  );
}

/** A small table preview: header row plus the first rows. */
export function MiniTable({ header, rows, more, highlight }: { header: readonly string[]; rows: ReadonlyArray<readonly string[]>; more: number; highlight?: string | undefined }) {
  return (
    <table className="mini-table">
      <thead>
        <tr>
          {header.map((h) => (
            <th key={h} className={h === highlight ? 'is-hl' : undefined}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} className={header[j] === highlight ? 'is-hl' : undefined}>
                {c}
              </td>
            ))}
          </tr>
        ))}
        {more > 0 ? (
          <tr>
            <td colSpan={header.length} className="mini-table__more">
              +{more} more
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}
