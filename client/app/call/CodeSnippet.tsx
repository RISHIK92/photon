"use client";

import { useState } from "react";
import { languageFor, parseLocator, tokenizeLine, type TokenKind } from "@/lib/highlight";

const COLOR: Record<TokenKind, string> = {
  plain: "text-neutral-300",
  keyword: "text-violet-300",
  string: "text-emerald-300",
  comment: "text-neutral-500 italic",
  number: "text-amber-200",
  function: "text-sky-300",
};

/** Code evidence, rendered as code.
 *
 * Two details make this usable mid-call rather than merely prettier:
 *
 * - Line numbers come from the LOCATOR, not from 1. The agent cites
 *   `pricing.py:L42-L58`, so the panel shows 42-58 and someone can say
 *   "line 47" and have everyone land in the same place in their own editor.
 * - Code never wraps. Wrapped code misaligns with its line numbers and
 *   turns indentation into noise, so the block scrolls horizontally on its
 *   own instead of stretching the panel.
 */
export default function CodeSnippet({
  locator,
  code,
  collapsedLines = 12,
}: {
  locator: string;
  code: string;
  collapsedLines?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const { path, startLine } = parseLocator(locator);
  const language = languageFor(path);
  const lines = code.replace(/\s+$/, "").split("\n");
  const hidden = Math.max(0, lines.length - collapsedLines);
  const shown = expanded ? lines : lines.slice(0, collapsedLines);

  const copy = async () => {
    try {
      // Raw code, without line numbers — the point of copying is to paste
      // it somewhere that runs it.
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the code is still selectable */
    }
  };

  return (
    <div className="border border-neutral-800 rounded-lg overflow-hidden bg-neutral-950">
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-neutral-800 bg-neutral-900/60">
        <span className="text-[11px] font-mono text-neutral-400 truncate flex-1" title={locator}>
          {path}
          {startLine !== null && <span className="text-neutral-600">:{startLine}</span>}
        </span>
        {language && <span className="text-[10px] text-neutral-600">{language}</span>}
        <button
          onClick={copy}
          className="text-[10px] text-neutral-500 hover:text-neutral-200 shrink-0"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>

      <div className="overflow-x-auto">
        <pre className="text-[11px] leading-[1.5] py-1.5 font-mono">
          {shown.map((line, i) => (
            <div key={i} className="flex hover:bg-neutral-900/60 px-2">
              <span className="select-none text-neutral-700 text-right pr-3 w-10 shrink-0 tabular-nums">
                {startLine !== null ? startLine + i : i + 1}
              </span>
              <code className="whitespace-pre">
                {tokenizeLine(line, language).map((token, k) => (
                  <span key={k} className={COLOR[token.kind]}>
                    {token.text}
                  </span>
                ))}
              </code>
            </div>
          ))}
        </pre>
      </div>

      {hidden > 0 && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full text-[11px] text-neutral-500 hover:text-neutral-200 py-1 border-t border-neutral-800"
        >
          {expanded ? "show less" : `show ${hidden} more line${hidden === 1 ? "" : "s"}`}
        </button>
      )}
    </div>
  );
}
