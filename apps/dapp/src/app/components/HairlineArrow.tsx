import { cn } from '@goldstandard/ui';

/**
 * A 1px engraved arrow that matches the gold hairline rules, used in place of a
 * stock icon. It nudges forward when its parent `group` is hovered.
 */
export function HairlineArrow({ className }: { className?: string }) {
  return (
    <svg
      width="22"
      height="10"
      viewBox="0 0 22 10"
      fill="none"
      aria-hidden
      className={cn(
        'overflow-visible transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-1',
        className
      )}
    >
      <path d="M0 5 H20" stroke="currentColor" strokeWidth="1" />
      <path
        d="M15.5 1 L20 5 L15.5 9"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="square"
        strokeLinejoin="miter"
        fill="none"
      />
    </svg>
  );
}
