import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';

interface InfoTipProps {
  children: ReactNode;
  /** Accessible label for the trigger button. */
  label?: string;
  className?: string;
}

const BUBBLE_WIDTH = 224;
const VIEWPORT_MARGIN = 8;
const GAP = 8;

/**
 * Explanatory tooltip on a 16px "?" with a 44px hit area. The bubble is rendered only
 * while open and positioned against the viewport, so it never adds width to the page
 * (a hidden absolute bubble near the right edge used to give phones a sideways scroll)
 * and never runs off screen. Opens on hover, focus or tap; Escape closes it.
 */
export function InfoTip({ children, label = 'More information', className }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>();
  const trigger = useRef<HTMLButtonElement>(null);
  const openBeforePointer = useRef<boolean>();
  const id = useId();

  const place = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(BUBBLE_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
    const centred = rect.left + rect.width / 2 - width / 2;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(centred, window.innerWidth - width - VIEWPORT_MARGIN));
    setStyle({ position: 'fixed', left, bottom: window.innerHeight - rect.top + GAP, width });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', close);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  return (
    <span
      className={`relative inline-flex ${className ?? ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => { openBeforePointer.current = undefined; setOpen(false); }}
        onPointerDown={() => { openBeforePointer.current = open; }}
        onPointerCancel={() => { openBeforePointer.current = undefined; }}
        onClick={() => {
          // A tap focuses the button before click, opening it through onFocus.
          // Toggle from the state before that focus so the first tap stays open.
          const previous = openBeforePointer.current;
          openBeforePointer.current = undefined;
          setOpen(current => !(previous ?? current));
        }}
        className="relative grid h-4 w-4 place-items-center rounded-full border border-input bg-muted text-[0.65rem] font-semibold leading-none text-muted-foreground transition-colors after:absolute after:-inset-[15px] after:content-[''] hover:border-primary/40 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
      >
        ?
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          style={style}
          className="z-50 rounded-lg border border-border bg-popover p-2.5 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-popover-foreground shadow-lift"
        >
          {children}
        </span>
      )}
    </span>
  );
}
