import Link from "next/link";

export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined text-[20px] ${className}`} aria-hidden>{name}</span>;
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-[20px] bg-card p-7 shadow-card ${className}`}>{children}</div>;
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
  const base = "inline-flex min-h-10 items-center justify-center gap-2 rounded-full px-[18px] text-sm font-semibold transition disabled:opacity-50 disabled:cursor-default";
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
