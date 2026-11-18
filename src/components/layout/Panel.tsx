import type { ReactNode } from 'react';
import { Icon, type IconName } from '../common/Icon';
import './Panel.css';

export interface PanelProps {
  readonly title: string;
  readonly icon: IconName;
  /** Accent token for the panel's icon badge, e.g. `--lab-function`. */
  readonly accentVar: string;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/** Standard workspace panel: compact header, scrollable body. */
export function Panel({ title, icon, accentVar, subtitle, actions, children, className }: PanelProps) {
  return (
    <section className={className ? `panel ${className}` : 'panel'} aria-label={title}>
      <header className="panel__header">
        <span className="panel__badge" style={{ color: `var(${accentVar})` }}>
          <Icon name={icon} />
        </span>
        <h2 className="panel__title">{title}</h2>
        {subtitle ? <div className="panel__subtitle">{subtitle}</div> : null}
        {actions ? <div className="panel__actions">{actions}</div> : null}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
