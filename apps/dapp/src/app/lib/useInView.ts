import { useEffect, useRef, useState } from 'react';

/**
 * Reveal-on-scroll helper. Returns a ref and a boolean that flips to true once
 * the element enters the viewport. Respects prefers-reduced-motion by reporting
 * visible immediately, so content never depends on animation to be readable.
 */
export function useInView<T extends HTMLElement = HTMLDivElement>(
  options: IntersectionObserverInit = { threshold: 0.15, rootMargin: '0px 0px -10% 0px' },
  skip = false
) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    // Skipped when CSS scroll-driven animation owns the reveal, or when the
    // element has no observable node.
    if (skip) {
      setInView(true);
      return;
    }

    const node = ref.current;
    if (!node) return;

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (reduceMotion || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }

    // Safety net: if the observer errors or never fires (for example an element
    // that never crosses the threshold), resolve to the settled state anyway so
    // content can never remain hidden.
    const fallback = window.setTimeout(() => setInView(true), 1200);

    try {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
          }
        });
      }, options);

      observer.observe(node);
      return () => {
        window.clearTimeout(fallback);
        observer.disconnect();
      };
    } catch {
      window.clearTimeout(fallback);
      setInView(true);
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip]);

  return { ref, inView };
}
