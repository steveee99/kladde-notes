import type { ReactNode } from 'react';

/**
 * Page header of the Werkbank design: full width with a line below, the title in the serif, a short summary below it
 * and the page's actions on the right. `display`: a larger title on a dotted ground (Home, the day sheet). Pages put
 * their content in `PageBody` below it.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  children,
  display,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  display?: boolean;
}) {
  return (
    <header className={`border-b border-line px-4 pb-3.5 pt-4 anim-fade-up nav:px-7 nav:pt-5 ${display ? 'paper-dots nav:pb-5 nav:pt-7' : ''}`}>
      <div className={`flex flex-wrap gap-x-4 gap-y-2.5 ${display ? 'items-end' : 'items-center'}`}>
        <div className="min-w-0 flex-1 basis-56">
          <h1 className={`font-display break-words ${display ? 'text-[30px] leading-9 nav:text-[38px] nav:leading-[44px]' : 'text-[23px] leading-8'}`}>{title}</h1>
          {subtitle && <p className={`text-body-m text-muted ${display ? 'mt-1.5' : 'mt-0.5'}`}>{subtitle}</p>}
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

/**
 * A section of a page (Today, Inbox on Home): no box around it, a serif heading over a line, a count or actions on
 * the right. The rows below bring their own dividers.
 */
export function Panel({ label, aside, children, className = '', labelId }: { label: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; labelId?: string }) {
  return (
    <section aria-labelledby={labelId} className={`min-w-0 ${className}`}>
      <div className="flex min-h-10 items-end justify-between gap-3 border-b border-line px-3.5 pb-2">
        <h2 id={labelId} className="panel-title">
          {label}
        </h2>
        {aside && <div className="flex items-center gap-1.5 text-muted">{aside}</div>}
      </div>
      {children}
    </section>
  );
}
