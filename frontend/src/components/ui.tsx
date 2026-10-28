import Link from "next/link";

export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined text-[20px] ${className}`} aria-hidden>{name}</span>;
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-[20px] bg-card p-5 shadow-card sm:p-7 ${className}`}>{children}</div>;
}

export function CardTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-center justify-between gap-4">
      <h2 className="text-[19px] font-semibold tracking-[-0.015em]">{children}</h2>
      {action}
    </div>
  );
}

const tones = {
  plum: "bg-primary-fixed text-ink",
  coral: "bg-ink/[0.07] text-ink",
  steel: "bg-muted/[0.12] text-[#4c5d71]",
  cerulean: "bg-primary/[0.09] text-primary",
  cream: "bg-soft text-ink-2",
  soft: "bg-soft text-muted",
  danger: "bg-danger-soft text-danger",
} as const;
export type Tone = keyof typeof tones;

export function Pill({ tone = "soft", children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex h-[26px] items-center gap-1 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
}

type BtnProps = { variant?: "primary" | "secondary" | "ghost"; href?: string; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({ variant = "secondary", href, className = "", children, ...rest }: BtnProps) {
  const base = "press inline-flex min-h-10 items-center justify-center gap-2 rounded-full px-[18px] text-sm font-semibold transition disabled:opacity-50 disabled:cursor-default";
  const look = {
    primary: "bg-primary text-white hover:bg-primary-container",
    secondary: "bg-card text-ink ring-1 ring-ink/[0.12] hover:bg-[#f7fafb]",
    ghost: "px-2 text-primary hover:text-ink",
  }[variant];
  const cls = `${base} ${look} ${className}`;
  if (href) return <Link href={href} className={cls}>{children}</Link>;
  return <button className={cls} {...rest}>{children}</button>;
}

/** Round submit arrow for chat inputs. Disabled keeps the arrow white on a lighter fill, so it never disappears. */
export function SendButton({ disabled }: { disabled: boolean }) {
  return (
    <button
      disabled={disabled}
      aria-label="Send"
      className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ink text-white transition hover:bg-primary disabled:cursor-default disabled:bg-ink/25"
    >
      <Icon name="arrow_upward" className="text-[20px]" />
    </button>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary-fixed text-primary"><Icon name={icon} className="text-[24px]" /></span>
      <p className="font-semibold">{title}</p>
      {children && <div className="max-w-sm text-sm leading-relaxed text-muted">{children}</div>}
    </div>
  );
}

/** A label that appears on hover or keyboard focus, so an icon-only control always says what it does. */
export function Tooltip({ label, children, side = "bottom" }: { label: string; children: React.ReactNode; side?: "bottom" | "top" | "right" | "left" }) {
  const place = {
    bottom: "left-1/2 top-full mt-2 -translate-x-1/2",
    top: "bottom-full left-1/2 mb-2 -translate-x-1/2",
    right: "left-full top-1/2 ml-2 -translate-y-1/2",
    left: "right-full top-1/2 mr-2 -translate-y-1/2",
  }[side];
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-lift transition-opacity duration-150 group-hover/tip:opacity-100 group-hover/tip:delay-300 group-focus-within/tip:opacity-100 ${place}`}
      >
        {label}
      </span>
    </span>
  );
}

type IconBtnProps = { icon: string; label: string; href?: string; tone?: "plain" | "soft"; tip?: "bottom" | "top" | "right" | "left" } &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">;

/** A round icon-only control. `label` is both its accessible name and its tooltip, so it is never a mystery. */
export function IconButton({ icon, label, href, tone = "plain", tip = "bottom", className = "", ...rest }: IconBtnProps) {
  const cls = `grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink-2 transition hover:bg-primary/[0.08] hover:text-ink disabled:opacity-40 ${
    tone === "soft" ? "bg-card ring-1 ring-ink/[0.1]" : ""
  } ${className}`;
  return (
    <Tooltip label={label} side={tip}>
      {href ? (
        <Link href={href} aria-label={label} className={cls}><Icon name={icon} /></Link>
      ) : (
        <button type="button" aria-label={label} className={cls} {...rest}><Icon name={icon} /></button>
      )}
    </Tooltip>
  );
}

/** Apple-style segmented control. Each segment is a real link, so tabs keep their own URL and the back button
 * works. With `onSelect` it switches something on the page instead: segments become toggle buttons in a group. */
export function Segmented({ items, active, label, onSelect }: { items: { href: string; label: string; badge?: number }[]; active: string; label: string; onSelect?: (href: string) => void }) {
  const segments = items.map((i) => {
    const on = i.href === active;
    const cls = `inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] transition motion-reduce:transition-none sm:flex-none sm:px-4 sm:text-sm ${
      on ? "bg-card font-semibold text-ink shadow-[0_1px_2px_rgb(54_33_62/0.08),0_0_0_1px_rgb(54_33_62/0.04)]" : "font-medium text-muted hover:text-ink"
    }`;
    const body = (
      <>
        {i.label}
        {!!i.badge && (
          <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1 text-[11px] font-semibold tabular-nums text-white" aria-label={`${i.badge} waiting`}>
            {i.badge}
          </span>
        )}
      </>
    );
    return onSelect ? (
      <button key={i.href} type="button" aria-pressed={on} onClick={() => onSelect(i.href)} className={cls}>{body}</button>
    ) : (
      <Link key={i.href} href={i.href} aria-current={on ? "page" : undefined} className={cls}>{body}</Link>
    );
  });
  const track = <div className="flex w-full gap-0.5 rounded-full bg-ink/[0.05] p-1 sm:inline-flex sm:w-auto">{segments}</div>;
  return onSelect ? <div role="group" aria-label={label}>{track}</div> : <nav aria-label={label}>{track}</nav>;
}

/** A quiet disclosure for facts most people never need: references, who approved, when. */
export function Details({ summary = "Details", children, className = "" }: { summary?: string; children: React.ReactNode; className?: string }) {
  return (
    <details className={`group/det ${className}`}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md text-[13px] font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        {summary}
        <Icon name="expand_more" className="text-[18px] transition-transform group-open/det:rotate-180" />
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/** A label and value pair inside Details. */
export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-6 py-1.5 text-[13px]">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium text-ink-2">{children}</dd>
    </div>
  );
}
