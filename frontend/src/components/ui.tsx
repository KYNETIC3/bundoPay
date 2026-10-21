import Link from "next/link";

export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined text-[20px] ${className}`} aria-hidden>{name}</span>;
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-card p-5 shadow-sm ${className}`}>{children}</div>;
}

export function CardTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold tracking-tight">{children}</h2>
      {action}
    </div>
  );
}

const tones = {
  plum: "bg-plum text-white",
  coral: "bg-coral text-white",
  steel: "bg-steel text-white",
  cerulean: "bg-cerulean text-white",
  cream: "bg-cream text-ink border border-cream-line",
  soft: "bg-soft text-ink-2 border border-line",
  danger: "bg-danger-soft text-danger",
} as const;
export type Tone = keyof typeof tones;

export function Pill({ tone = "soft", children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px] font-semibold whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
}

type BtnProps = { variant?: "primary" | "secondary" | "ghost"; href?: string; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({ variant = "secondary", href, className = "", children, ...rest }: BtnProps) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:opacity-50 disabled:cursor-default";
  const look = {
    primary: "bg-primary text-white hover:bg-primary-container shadow-sm",
    secondary: "border border-line-strong bg-card text-ink hover:bg-soft",
    ghost: "text-primary hover:bg-soft",
  }[variant];
  const cls = `${base} ${look} ${className}`;
  if (href) return <Link href={href} className={cls}>{children}</Link>;
  return <button className={cls} {...rest}>{children}</button>;
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <Icon name={icon} className="text-[32px] text-line-strong" />
      <p className="font-semibold">{title}</p>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}
