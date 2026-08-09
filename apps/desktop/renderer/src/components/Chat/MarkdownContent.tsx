import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

export function MarkdownContent({ content }: { content: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(content) as string),
    [content]
  );
  return (
    <div
      className="message-markdown"
      onClick={(event) => {
        const target = event.target as HTMLElement;
        const anchor = target.closest('a');
        if (!anchor) return;
        event.preventDefault();
        const href = anchor.getAttribute('href');
        if (!href) return;
        try {
          const url = new URL(href);
          if (url.protocol === 'https:' && url.hostname === 'wiki.guildwars2.com') {
            void window.gw2cc.request('app.openExternal', { url: url.toString() });
          }
        } catch {
          // Invalid or relative links remain inert inside the desktop renderer.
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
