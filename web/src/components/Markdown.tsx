import { memo, type MouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { rawUrl, workspaceLink } from '../files.ts';

// GitHub-flavored Markdown for reading only: remark-gfm adds the GFM serializer too (mdast-util-to-markdown and
// markdown-table), which turning Markdown into a page never calls.
function gfmParse(this: { data(): unknown }) {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push(gfm());
  (data.fromMarkdownExtensions ??= []).push(gfmFromMarkdown());
}
const remarkPlugins = [gfmParse];

// Links and images into the workspace point at the Boton's files, relative to `dir`. Raw HTML is never rendered.
export const Markdown = memo(function Markdown(props: { text: string; botId?: string; workspace?: string; dir?: string; onOpenFile?: (path: string) => void }) {
  const { botId, workspace, dir, onOpenFile } = props;
  const fileOf = (url: unknown) => (botId && workspace && typeof url === 'string' ? workspaceLink(url, workspace, dir) : null);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={{
          a: ({ node: _n, href, ...rest }) => {
            const path = fileOf(href);
            if (path === null || !botId) return <a {...rest} href={href} target="_blank" rel="noreferrer noopener" />;
            const open = (e: MouseEvent) => {
              if (!onOpenFile || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              onOpenFile(path);
            };
            return <a {...rest} href={rawUrl(botId, path)} target="_blank" rel="noreferrer noopener" onClick={open} />;
          },
          // Chrome keeps an object for every <thead> ever inserted until the page closes, so a table's header row goes
          // in a <tbody>; scope="col" keeps its cells the column headers for screen readers.
          thead: ({ node: _n, ...rest }) => <tbody {...rest} />,
          th: ({ node: _n, ...rest }) => <th scope="col" {...rest} />,
          img: ({ node: _n, src, alt, ...rest }) => {
            const path = fileOf(src);
            return <img {...rest} alt={alt ?? ''} src={path === null || !botId ? src : rawUrl(botId, path)} loading="lazy" />;
          },
        }}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  );
});
