import type { ReactNode } from 'react';

/**
 * Page header of the Werkbank design: full width with a line below, a 20px title, a short summary next to or below
 * it and the page's actions on the right. Pages put their content in `PageBody` below it.
 */
export function PageHeader({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="border-b border-line px-4 pb-3.5 pt-4 anim-fade-up nav:px-7 nav:pt-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="break-words text-title-l text-strong">{title}</h1>
          {subtitle && <p className="mt-0.5 text-body-m text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/** The content below a `PageHeader`: the same side padding, full width up to a comfortable maximum */
export function PageBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1600px] px-4 py-5 nav:px-7 ${className}`}>{children}</div>;
}

/** A card with a caption row (uppercase label, a count or actions on the right), like Today or Inbox on Home */
export function Panel({ label, aside, children, className = '', labelId }: { label: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; labelId?: string }) {
  return (
    <section aria-labelledby={labelId} className={`card min-w-0 overflow-hidden ${className}`}>
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-line px-3.5 py-1.5">
        <h2 id={labelId} className="section-label">
          {label}
        </h2>
        {aside && <div className="flex items-center gap-1.5 text-muted">{aside}</div>}
      </div>
      {children}
    </section>
  );
}
