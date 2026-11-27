import { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import {
  ChevronRightIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
} from '@heroicons/react/20/solid';
import { cn } from '@goldstandard/ui';
import { SectionHeader } from '../components/marketing/Section';
import { DOC_GROUPS, type DocItem, type DocGroup } from './registry';

export interface TocEntry {
  id: string;
  text: string;
  level: 2 | 3;
}

interface DocsLayoutProps {
  item: DocItem;
  group: DocGroup;
  prev: DocItem | undefined;
  next: DocItem | undefined;
  toc: TocEntry[];
  children: ReactNode;
}

function SidebarNav() {
  return (
    <nav aria-label="Documentation" className="space-y-6">
      {DOC_GROUPS.map((g) => (
        <div key={g.title}>
          <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {g.title}
          </p>
          <ul className="space-y-0.5">
            {g.items.map((it) => (
              <li key={it.slug}>
                <NavLink
                  to={`/docs/${it.slug}`}
                  className={({ isActive }) =>
                    cn(
                      'flex min-h-11 items-center rounded-md px-3 py-1.5 text-sm transition-colors',
                      isActive
                        ? 'bg-accent font-medium text-primary'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                    )
                  }
                >
                  {it.title}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function MobileDocsNav({ item, group }: { item: DocItem; group: DocGroup }) {
  return (
    <details className="group mb-6 rounded-xl border border-border bg-card lg:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">{group.title}</span>
          <ChevronRightIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="text-foreground">{item.title}</span>
        </span>
        <ChevronDownIcon
          className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="border-t border-border px-2 py-3">
        <SidebarNav />
      </div>
    </details>
  );
}

function PrevNextCard({ item, direction }: { item: DocItem; direction: 'prev' | 'next' }) {
  const isPrev = direction === 'prev';
  return (
    <NavLink
      to={`/docs/${item.slug}`}
      className={cn(
        'group flex flex-1 flex-col gap-1 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/30 hover:bg-accent/40',
        isPrev ? 'items-start text-left' : 'items-end text-right'
      )}
    >
      <span className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {isPrev && <ArrowLeftIcon className="h-3.5 w-3.5" aria-hidden />}
        {isPrev ? 'Previous' : 'Next'}
        {!isPrev && <ArrowRightIcon className="h-3.5 w-3.5" aria-hidden />}
      </span>
      <span className="font-serif text-base font-semibold text-foreground group-hover:text-primary">
        {item.title}
      </span>
    </NavLink>
  );
}

export function DocsLayout({ item, group, prev, next, toc, children }: DocsLayoutProps) {
  return (
    <div className="container py-8 lg:py-12">
      <MobileDocsNav item={item} group={group} />

      <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10 xl:grid-cols-[15rem_minmax(0,1fr)_13rem] xl:gap-12">
        {/* Sidebar */}
        <aside aria-label="Documentation sections" className="hidden lg:block">
          <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pb-8 pr-2">
            <SidebarNav />
          </div>
        </aside>

        {/* Content */}
        <article className="min-w-0">
          <nav aria-label="Breadcrumb" className="label-mono mb-4 flex items-center gap-1.5 text-xs text-primary">
            <NavLink to="/docs" className="inline-flex min-h-11 min-w-11 items-center hover:text-foreground">
              Docs
            </NavLink>
            <ChevronRightIcon className="h-3 w-3 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">{group.title}</span>
          </nav>
          <SectionHeader title={item.title} as="h1" align="left" variant="stack" />

          <div className="mt-6">{children}</div>

          {(prev || next) && (
            <div className="mt-12 flex flex-col gap-3 border-t border-border pt-8 sm:flex-row">
              {prev ? <PrevNextCard item={prev} direction="prev" /> : <div className="flex-1" />}
              {next ? <PrevNextCard item={next} direction="next" /> : <div className="flex-1" />}
            </div>
          )}
        </article>

        {/* On this page */}
        <aside aria-label="On this page" className="hidden xl:block">
          {toc.length > 0 && (
            <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                On this page
              </p>
              <ul className="space-y-1.5 border-l border-border text-sm">
                {toc.map((entry) => (
                  <li key={entry.id} className={entry.level === 3 ? 'pl-3' : ''}>
                    <a
                      href={`#${entry.id}`}
                      className="-ml-px block border-l border-transparent pl-3 text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                    >
                      {entry.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
