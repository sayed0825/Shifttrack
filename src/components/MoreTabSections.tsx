import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';

export interface MoreTabSection {
  id: string;
  title: string;
  icon: LucideIcon;
  count?: ReactNode;
  /** Leaf section: renders its own content. Mutually exclusive with `sections`. */
  render?: () => ReactNode;
  /** Parent section: opens a second-level list instead of rendering directly. */
  sections?: MoreTabSection[];
}

function SectionList({ sections, onSelect }: { sections: MoreTabSection[]; onSelect: (id: string) => void }): ReactNode {
  return (
    <ul className="mx-auto max-w-3xl divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
      {sections.map((section) => {
        const Icon = section.icon;
        return (
          <li key={section.id}>
            <button
              type="button"
              onClick={() => onSelect(section.id)}
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

function BackHeader({ title, Icon, onBack }: { title: string; Icon: LucideIcon; onBack: () => void }): ReactNode {
  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="-ml-2 flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ink/70 hover:bg-bg hover:text-ink"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Back
      </button>
      <h2 className="mb-4 mt-1 flex items-center gap-2 font-display text-lg tracking-tight text-ink">
        <Icon className="h-5 w-5 text-ink/50" aria-hidden="true" />
        {title}
      </h2>
    </>
  );
}

export default function MoreTabSections({ sections }: { sections: MoreTabSection[] }): ReactNode {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [subActiveId, setSubActiveId] = useState<string | null>(null);
  const active = sections.find((s) => s.id === activeId) ?? null;
  const subSections = active?.sections ?? null;
  const subActive = subSections?.find((s) => s.id === subActiveId) ?? null;

  if (active && subSections) {
    if (subActive) {
      return (
        <div className="mx-auto max-w-3xl">
          <BackHeader title={subActive.title} Icon={subActive.icon} onBack={() => setSubActiveId(null)} />
          {subActive.render?.()}
        </div>
      );
    }

    return (
      <div className="mx-auto max-w-3xl">
        <BackHeader title={active.title} Icon={active.icon} onBack={() => setActiveId(null)} />
        <SectionList sections={subSections} onSelect={setSubActiveId} />
      </div>
    );
  }

  if (active) {
    return (
      <div className="mx-auto max-w-3xl">
        <BackHeader title={active.title} Icon={active.icon} onBack={() => setActiveId(null)} />
        {active.render?.()}
      </div>
    );
  }

  return <SectionList sections={sections} onSelect={setActiveId} />;
}
