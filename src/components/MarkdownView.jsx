import { useEffect, useId, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import mermaid from 'mermaid';
import 'katex/dist/katex.min.css';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'strict',
  themeVariables: {
    background: '#000000',
    primaryColor: '#18181b',
    primaryTextColor: '#ffffff',
    primaryBorderColor: '#3f3f46',
    lineColor: '#a78bfa',
    secondaryColor: '#111827',
    tertiaryColor: '#020617',
  },
});

function MermaidBlock({ chart }) {
  const reactId = useId();
  const [svg, setSvg] = useState('');

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

    mermaid
      .render(id, chart)
      .then(({ svg: rendered }) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch(() => {
        if (!cancelled) setSvg('');
      });

    return () => {
      cancelled = true;
    };
  }, [chart, reactId]);

  if (!svg) {
    return <pre className="overflow-x-auto rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/80">{chart}</pre>;
  }

  return (
    <div
      className="my-6 overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03] p-4"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export default function MarkdownView({ markdown }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        h1: ({ children }) => <h1 className="mb-5 text-4xl font-semibold tracking-tight text-white">{children}</h1>,
        h2: ({ children }) => <h2 className="mt-10 mb-3 text-2xl font-semibold tracking-tight text-white">{children}</h2>,
        h3: ({ children }) => <h3 className="mt-7 mb-2 text-xl font-semibold text-white">{children}</h3>,
        p: ({ children }) => <p className="my-4 leading-7 text-white/75">{children}</p>,
        ul: ({ children }) => <ul className="my-4 list-disc space-y-2 pl-6 text-white/75">{children}</ul>,
        ol: ({ children }) => <ol className="my-4 list-decimal space-y-2 pl-6 text-white/75">{children}</ol>,
        li: ({ children }) => <li className="pl-1">{children}</li>,
        table: ({ children }) => (
          <div className="my-5 overflow-x-auto rounded-xl border border-white/10">
            <table className="min-w-full border-collapse text-left text-sm text-white/75">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border-b border-white/10 bg-white/10 px-4 py-3 font-semibold text-white">{children}</th>,
        td: ({ children }) => <td className="border-b border-white/10 px-4 py-3 align-top">{children}</td>,
        code: ({ className, children }) => {
          const match = /language-(\w+)/.exec(className || '');
          const language = match?.[1];
          const value = String(children).replace(/\n$/, '');

          if (language === 'mermaid') {
            return <MermaidBlock chart={value} />;
          }

          if (language) {
            return (
              <pre className="my-5 overflow-x-auto rounded-xl border border-white/10 bg-zinc-950 p-4 text-sm text-white/80">
                <code>{value}</code>
              </pre>
            );
          }

          return <code className="rounded bg-white/10 px-1.5 py-0.5 text-white">{children}</code>;
        },
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
