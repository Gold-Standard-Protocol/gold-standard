import { type ReactNode } from 'react';
import { cn } from '@goldstandard/ui';
import { InfoTip } from './InfoTip';

interface MetricProps {
  label: string;
  value: ReactNode;
  /** Small unit shown next to the value, e.g. GSUSD, %, oz. */
  unit?: string;
  /** Supporting line under the value. */
  hint?: ReactNode;
  /** Optional explanation surfaced via an info tooltip on the label. */
  info?: string;
  size?: 'sm' | 'md' | 'lg';
  /** Renders a contained card surface around the metric. */
  bordered?: boolean;
  className?: string;
  /** Accent the value in the brand gold. */
  accent?: boolean;
}

const valueSize = {
  sm: 'text-xl',
  md: 'text-2xl sm:text-3xl',
  lg: 'text-3xl sm:text-4xl xl:text-5xl',
} as const;

/**
 * A single reported figure. Numbers use tabular, lining figures so columns of
 * metrics align. Shared across the landing strip, reserves dashboard and vault.
 */
export function Metric({
  label,
  value,
  unit,
  hint,
  info,
  size = 'md',
  bordered = false,
  className,
  accent = false,
}: MetricProps) {
  return (
    <div
      className={cn(
        'min-w-0',
        bordered &&
          'rounded-xl border border-border bg-card px-5 py-4',
        className
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="label-mono text-xs text-muted-foreground">
          {label}
        </span>
        {info && <InfoTip label={`About ${label}`}>{info}</InfoTip>}
      </div>
      <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5">
        <span
          className={cn(
            'nums whitespace-nowrap font-serif font-semibold leading-none',
            valueSize[size],
            accent ? 'text-primary' : 'text-foreground'
          )}
        >
          {value}
        </span>
        {unit && (
          <span className="text-sm font-medium text-muted-foreground">
            {unit}
          </span>
        )}
      </p>
      {hint && (
        <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
