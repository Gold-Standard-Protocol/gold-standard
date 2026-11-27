import { useEffect, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { applyDescription } from '../lib/routes';
import { findDoc } from './registry';
import { DocsLayout, type TocEntry } from './DocsLayout';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * Route controller for /docs/:slug. Renders the matching page inside the docs
 * layout, and after each navigation scans the rendered content for h2/h3
 * headings to build the "on this page" contents and anchor targets.
 */
export default function DocsPage() {
  const { slug } = useParams<{ slug: string }>();
  const contentRef = useRef<HTMLDivElement>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const loc = slug ? findDoc(slug) : undefined;

  useEffect(() => {
    if (typeof window !== 'undefined') window.scrollTo(0, 0);

    const node = contentRef.current;
    if (!node) {
      setToc([]);
      return;
    }

    const headings = Array.from(
      node.querySelectorAll<HTMLHeadingElement>('h2, h3')
    );
    const seen = new Set<string>();
    const entries: TocEntry[] = headings.map((el) => {
      const text = el.textContent ?? '';
      let id = el.id || slugify(text);
      while (seen.has(id)) id = `${id}-x`;
      seen.add(id);
      el.id = id;
      return { id, text, level: el.tagName === 'H3' ? 3 : 2 };
    });
    setToc(entries);

    if (loc) {
      document.title = `${loc.item.title} · Gold Standard Docs`;
      applyDescription(document, loc.item.description);
    }
    // loc is derived deterministically from slug; depending on slug alone
    // avoids an infinite re-render loop from the freshly-built loc object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  if (!loc) {
    return <Navigate to="/docs/introduction" replace />;
  }

  const Page = loc.item.component;

  return (
    <DocsLayout
      item={loc.item}
      group={loc.group}
      prev={loc.prev}
      next={loc.next}
      toc={toc}
    >
      <div ref={contentRef}>
        <Page />
      </div>
    </DocsLayout>
  );
}
