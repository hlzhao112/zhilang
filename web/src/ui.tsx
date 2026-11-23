import type { ReactNode } from 'react';

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="overlay" onMouseDown={props.onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <h3>{props.title}</h3>
          <button className="icon-btn" onClick={props.onClose} aria-label="关闭">×</button>
        </header>
        <div className="modal-body">{props.children}</div>
        {props.footer ? <footer>{props.footer}</footer> : null}
      </div>
    </div>
  );
}

export function Pill(props: { tone?: 'ok' | 'warn' | 'muted'; children: ReactNode }) {
  return <span className={`pill ${props.tone ?? ''}`}>{props.children}</span>;
}
