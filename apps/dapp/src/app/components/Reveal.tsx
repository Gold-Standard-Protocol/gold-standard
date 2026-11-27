import { type ReactNode } from 'react';
import { cn } from '@goldstandard/ui';
import { useInView } from '../lib/useInView';

interface RevealProps {
  children: ReactNode;
  className?: string;
  /** Stagger delay in milliseconds. */
  delay?: number;
  as?: 'div' | 'section' | 'li' | 'article' | 'span';
}

/**
 * Fades and rises its children once, when they first enter the viewport, driven by an
 * IntersectionObserver. The observer reports "in view" immediately under reduced motion
 * and whenever it cannot observe, so content never depends on motion to be read. Used
 * once per section, not per item (docs DESIGN.md, MOTION 2).
 */
export function Reveal({ children, className, delay = 0, as = 'div' }: RevealProps) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const Tag = as as 'div';

  return (
    <Tag
      ref={ref}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
      className={cn(
        'motion-safe:transition-all motion-safe:duration-700 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]',
        inView ? 'opacity-100' : 'motion-safe:opacity-0 motion-safe:translate-y-4',
        className
      )}
    >
      {children}
    </Tag>
  );
}
