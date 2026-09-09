import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';

export interface MoreTabSection {
  id: string;
  title: string;
  icon: LucideIcon;
  count?: ReactNode;
  render: () => ReactNode;
}

export default function MoreTabSections({ sections }: { sections: MoreTabSection[] }): ReactNode {
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = sections.find((s) => s.id === activeId) ?? null;

  if (active) {
    const ActiveIcon = active.icon;
    return (
      <div className="mx-auto max-w-3xl">
        <button
          type="button"
          onClick={() => setActiveId(null)}
          className="-ml-2 flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ink/70 hover:bg-bg hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </button>
        <h2 className="mb-4 mt-1 flex items-center gap-2 font-display text-lg tracking-tight text-ink">
          <ActiveIcon className="h-5 w-5 text-ink/50" aria-hidden="true" />
          {active.title}
        </h2>
        {active.render()}
      </div>
    );
  }

  return (
    <ul className="mx-auto max-w-3xl divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
      {sections.map((section) => {
        const Icon = section.icon;
        return (
          <li key={section.id}>
            <button
              type="button"
              onClick={() => setActiveId(section.id)}
              className="flex min-h-[44px] w-full items-center gap-3 px-5 py-4 text-left hover:bg-bg"
            >
              <Icon className="h-5 w-5 shrink-0 text-ink/50" aria-hidden="true" />
              <span className="flex-1 text-sm font-medium text-ink">{section.title}</span>
              {section.count != null && section.count !== '' && section.count !== false && (
                <span className="shrink-0">{section.count}</span>
              )}
              <ChevronRight className="h-4 w-4 shrink-0 text-ink/40" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
