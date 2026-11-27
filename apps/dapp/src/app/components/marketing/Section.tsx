import { type ReactNode } from 'react';
import { cn } from '@goldstandard/ui';
import { Reveal } from '../Reveal';

interface SectionProps {
  children: ReactNode;
  id?: string;
  className?: string;
  /** Adds a faint vellum surface to separate alternating sections. */
  surface?: boolean;
}

/** Full-width marketing section with consistent vertical rhythm. */
export function Section({ children, id, className, surface = false }: SectionProps) {
  return (
    <section id={id} className={cn('relative py-16 sm:py-24', surface && 'bg-muted/40', className)}>
      {children}
    </section>
  );
}

interface SectionHeaderProps {
  /** A short kicker above the title. Only for information the title does not carry, never a repeat of it. */
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  align?: 'left' | 'center';
  /** `broadsheet` sets the title and lead asymmetrically across a wide grid. */
  variant?: 'stack' | 'broadsheet';
  /** Heading level for the title. Page openers use `h1`; sections use `h2`. */
  as?: 'h1' | 'h2';
  className?: string;
}

/**
 * Editorial section opener: a large serif title and a lead. The `broadsheet` variant sets
 * the title and lead across an asymmetric grid so the landing's openers differ from the
 * app pages' stacked ones.
 */
export function SectionHeader({
  eyebrow,
  title,
  lead,
  align = 'left',
  variant = 'stack',
  as: Heading = 'h2',
  className,
}: SectionHeaderProps) {
  const kicker = eyebrow && <span className="label-mono mb-5 block text-xs text-muted-foreground">{eyebrow}</span>;

  if (variant === 'broadsheet') {
    return (
      <Reveal className={cn('relative grid grid-cols-1 gap-x-12 gap-y-6 lg:grid-cols-12 lg:items-end', className)}>
        <div className="relative lg:col-span-7">
          {kicker}
          <Heading
            className="text-balance font-serif font-semibold leading-[1.06] tracking-[-0.01em] text-foreground"
            style={{ fontSize: 'var(--step-title)' }}
          >
            {title}
          </Heading>
        </div>
        {lead && (
          <p className="text-pretty leading-relaxed text-muted-foreground lg:col-span-4 lg:col-start-9 lg:pb-1">{lead}</p>
        )}
      </Reveal>
    );
  }

  return (
    <Reveal
      className={cn(
        'relative flex max-w-2xl flex-col',
        align === 'center' ? 'mx-auto items-center text-center' : 'items-start text-left',
        className
      )}
    >
      {kicker}
      <Heading
        className="text-balance font-serif font-semibold leading-[1.08] tracking-[-0.01em] text-foreground"
        style={{ fontSize: 'var(--step-title)' }}
      >
        {title}
      </Heading>
      {lead && <p className="mt-5 text-pretty text-[1.05rem] leading-relaxed text-muted-foreground">{lead}</p>}
    </Reveal>
  );
}
