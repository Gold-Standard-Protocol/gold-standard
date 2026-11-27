import { type ComponentType, type ReactNode, type SVGProps } from 'react';
import {
  InformationCircleIcon,
  LightBulbIcon,
  ExclamationTriangleIcon,
  ShieldExclamationIcon,
} from '@heroicons/react/24/outline';
import { cn } from '@goldstandard/ui';

/**
 * Documentation primitives. Doc pages compose these plus plain semantic HTML
 * inside <Prose>, which carries the `.doc-prose` typographic styles. Headings
 * are picked up automatically for the on-this-page contents by DocsPage.
 */

export function Prose({ children }: { children: ReactNode }) {
  return <div className="doc-prose">{children}</div>;
}

export function Lead({ children }: { children: ReactNode }) {
  return (
    <p className="mb-8 text-pretty text-lg leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

type CalloutVariant = 'note' | 'tip' | 'warning' | 'danger';

const calloutConfig: Record<
  CalloutVariant,
  { icon: ComponentType<SVGProps<SVGSVGElement>>; box: string; iconColor: string; label: string }
> = {
  note: {
    icon: InformationCircleIcon,
    box: 'border-primary/20 bg-accent/50',
    iconColor: 'text-primary',
    label: 'Note',
  },
  tip: {
    icon: LightBulbIcon,
    box: 'border-success/20 bg-success-soft',
    iconColor: 'text-success',
    label: 'Tip',
  },
  warning: {
    icon: ExclamationTriangleIcon,
    box: 'border-warning/25 bg-warning-soft',
    iconColor: 'text-warning',
    label: 'Important',
  },
  danger: {
    icon: ShieldExclamationIcon,
    box: 'border-danger/20 bg-danger-soft',
    iconColor: 'text-danger',
    label: 'Risk',
  },
};

export function Callout({
  variant = 'note',
  title,
  children,
}: {
  variant?: CalloutVariant;
  title?: string;
  children: ReactNode;
}) {
  const cfg = calloutConfig[variant];
  const Icon = cfg.icon;
  return (
    <div className={cn('my-6 flex gap-3 rounded-xl border p-4', cfg.box)}>
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', cfg.iconColor)} aria-hidden />
      <div className="min-w-0 text-sm leading-relaxed text-foreground">
        <p className={cn('label-mono mb-1 text-xs', cfg.iconColor)}>
          {title ?? cfg.label}
        </p>
        <div className="callout-body [&_p]:mb-2 [&_p:last-child]:mb-0">
          {children}
        </div>
      </div>
    </div>
  );
}

export interface Step {
  title: string;
  detail: ReactNode;
}

export function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="my-6 space-y-4">
      {steps.map((step, i) => (
        <li key={step.title} className="flex gap-4">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-primary/20 bg-accent text-sm font-semibold text-primary"
            aria-hidden
          >
            {i + 1}
          </span>
          <div className="min-w-0 pt-0.5">
            <p className="font-semibold text-foreground">{step.title}</p>
            <div className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {step.detail}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The header a comparison table's first column gets when the page leaves it blank. */
const ROW_HEADER_NAME = 'Property';

/** Accessible name for a table's scroll region, from the string column headers. */
export function tableName(head: ReactNode[], label?: string): string {
  if (label) return label;
  const columns = head.filter((h): h is string => typeof h === 'string' && h.length > 0);
  if (columns.length === 0) return 'Table';
  if (columns.length === 1) return `Table of ${columns[0]}`;
  return `Table of ${columns.slice(0, -1).join(', ')} and ${columns[columns.length - 1]}`;
}

export function DocTable({
  head,
  rows,
  label,
}: {
  head: ReactNode[];
  rows: ReactNode[][];
  label?: string;
}) {
  return (
    // At phone width the table scrolls sideways, so the wrapper must take keyboard focus
    // and carry a name (WCAG 2.1.1, axe scrollable-region-focusable).
    <div
      className="my-6 overflow-x-auto rounded-xl border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      role="region"
      aria-label={tableName(head, label)}
      tabIndex={0}
    >
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50 text-left">
            {head.map((h, i) => (
              <th
                key={i}
                scope="col"
                className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {h === '' ? <span className="sr-only">{ROW_HEADER_NAME}</span> : h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={ri}
              className="border-b border-border/70 last:border-0 align-top"
            >
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={cn(
                    'px-4 py-3 text-foreground',
                    ci === 0 && 'font-medium'
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface Feature {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  detail: ReactNode;
}

export function FeatureGrid({ features }: { features: Feature[] }) {
  return (
    <div className="my-6 grid gap-4 sm:grid-cols-2">
      {features.map((f) => {
        const Icon = f.icon;
        return (
          <div
            key={f.title}
            className="rounded-xl border border-border bg-card p-5"
          >
            <Icon className="mb-3 h-6 w-6 text-primary" aria-hidden />
            <p className="font-semibold text-foreground">{f.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {f.detail}
            </p>
          </div>
        );
      })}
    </div>
  );
}
