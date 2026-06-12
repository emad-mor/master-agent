"use client";

// Styled markdown renderer for assistant replies. GFM (tables, task lists,
// strikethrough, autolinks) via remark-gfm, with custom-styled elements so
// answers read cleanly — proper headings, lists, code blocks, links, tables.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./markdown.css";

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // External links open in a new tab; relative ones stay inert-safe.
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="md-link">{children}</a>
          ),
          code: ({ className, children, ...props }) => {
            const inline = !className;
            return inline
              ? <code className="md-code-inline" {...props}>{children}</code>
              : <code className={`md-code ${className ?? ""}`} {...props}>{children}</code>;
          },
          pre: ({ children }) => <pre className="md-pre">{children}</pre>,
          table: ({ children }) => <div className="md-table-wrap"><table className="md-table">{children}</table></div>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
