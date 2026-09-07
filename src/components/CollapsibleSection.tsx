import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';

export default function CollapsibleSection({
  title,
  icon: Icon,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  count?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  const userToggled = useRef(false);

  // defaultOpen often depends on data that hasn't loaded yet on first
  // render (a pending count starts at 0 until the fetch resolves). Once it
  // flips true, open automatically — but only until the user has toggled
  // this section themselves, so we never fight a deliberate collapse.
  useEffect(() => {
    if (defaultOpen && !userToggled.current) setOpen(true);
  }, [defaultOpen]);

  const toggle = () => {
    userToggled.current = true;
    setOpen((prev) => !prev);
  };

  return (
    <section className="rounded-2xl border border-border bg-surface">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center gap-2 p-5 text-left"
      >
        {Icon && <Icon className="h-5 w-5 shrink-0 text-ink/50" aria-hidden="true" />}
        <h3 className="flex-1 text-sm font-semibold text-ink">{title}</h3>
        {count != null && count !== '' && count !== false && <span className="shrink-0">{count}</span>}
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-ink/50 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </section>
  );
}
