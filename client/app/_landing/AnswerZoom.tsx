"use client";

import { useRef } from "react";
import { map, useSectionProgress } from "./scroll";
import { WordsReveal } from "./Reveal";

const EVIDENCE = [
  { type: "slack", loc: "slack:#pricing:1723641900.004", txt: "Priya: BLR Mobility signed — partner tier gets 0.88x in Bangalore only." },
  { type: "code", loc: "app/pricing.py:L42-L58", txt: "if city in PARTNER_CITY_RATES: rate *= PARTNER_CITY_RATES[city]" },
  { type: "commit", loc: "MER-412 · 3f9a1c2", txt: "pricing: partner rate override for BLR (see #128)" },
];

const ICON: Record<string, string> = { slack: "◆", code: "⌘", commit: "↯" };

/** An inline citation chip — what an `[ev_xxx]` marker renders as in the panel. */
function Chip({ id }: { id: string }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 align-middle text-[11px]"
      style={{ background: "rgba(28,25,23,.06)", color: "var(--l-rust)" }}
    >
      {id}
    </span>
  );
}

/**
 * The pinned rack-in on the product itself: the answer card starts small and
 * far away, scales up as you scroll through the section, and its citation
 * chips land one at a time near the end.
 */
export default function AnswerZoom() {
  const ref = useRef<HTMLDivElement>(null);
  const p = useSectionProgress(ref);

  const scale = map(p, 0, 0.55, 0.68, 1);
  const lift = map(p, 0, 0.55, 60, 0);
  const soft = map(p, 0, 0.35, 8, 0);
  const chips = map(p, 0.5, 0.8, 0, 1);

  return (
    <section id="answer" ref={ref} className="relative" style={{ height: "260vh" }}>
      <div className="sticky top-0 flex h-screen items-center overflow-hidden">
        <div className="mx-auto w-full max-w-6xl px-6 md:px-10">
          <div className="grid items-center gap-14 md:grid-cols-[0.85fr_1.15fr]">
            <div>
              <div className="flex items-center gap-4">
                <span className="h-px w-10" style={{ background: "var(--l-rust)" }} />
                <span
                  className="text-[11px] tracking-[0.28em] uppercase"
                  style={{ color: "var(--l-muted)" }}
                >
                  What it returns
                </span>
              </div>
              <WordsReveal
                text="Every sentence carries its receipt."
                serifWords={[3, 4]}
                className="mt-6 text-[clamp(30px,4vw,52px)] leading-[1.08]"
              />
              <p
                className="mt-6 max-w-md text-[15px] leading-relaxed"
                style={{ color: "var(--l-ink-2)" }}
              >
                The agent plans a handful of tool calls, runs them in parallel, composes
                from what came back, then strips any claim whose citation does not
                resolve. If nothing survives, it says so out loud instead of guessing.
              </p>
              <div className="mt-8 flex gap-8">
                {[
                  ["2.07s", "median turn"],
                  ["24/24", "eval, base set"],
                  ["17", "tools registered"],
                ].map(([n, l]) => (
                  <div key={l}>
                    <div
                      className="text-[26px] leading-none"
                      style={{ fontFamily: "var(--font-display)", color: "var(--l-ink)" }}
                    >
                      {n}
                    </div>
                    <div
                      className="mt-2 text-[10px] tracking-[0.2em] uppercase"
                      style={{ color: "var(--l-muted)" }}
                    >
                      {l}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div
              style={{
                transform: `scale(${scale}) translateY(${lift}px)`,
                filter: `blur(${soft}px)`,
                willChange: "transform, filter",
              }}
            >
              <div
                className="rounded-2xl p-6 md:p-8"
                style={{
                  background: "var(--l-paper)",
                  border: "1px solid var(--l-rule)",
                  boxShadow: "0 50px 120px -60px rgba(28,25,23,.55)",
                }}
              >
                <div className="flex items-center justify-between">
                  <span
                    className="text-[10px] tracking-[0.24em] uppercase"
                    style={{ color: "var(--l-muted)" }}
                  >
                    Turn · voice
                  </span>
                  <span
                    className="rounded-full px-2.5 py-1 text-[10px] tracking-[0.18em] uppercase"
                    style={{ background: "rgba(180,83,9,.10)", color: "var(--l-rust)" }}
                  >
                    confidence high
                  </span>
                </div>

                <p className="mt-5 text-[13px]" style={{ color: "var(--l-muted)" }}>
                  “Why does pricing have a special case for Bangalore?”
                </p>

                <p
                  className="mt-4 text-[17px] leading-relaxed"
                  style={{ color: "var(--l-ink)" }}
                >
                  Bangalore is a partner city — a reseller agreement with BLR Mobility
                  gives partner-tier accounts a 0.88x rate there <Chip id="ev_80abd768" />{". It is a deliberate business decision, not a bug "}<Chip id="ev_7fa701ec" />{"."}
                </p>

                <div
                  className="mt-6 flex flex-wrap gap-2 border-t pt-5"
                  style={{ borderColor: "var(--l-rule)" }}
                >
                  {["search_code · 412ms", "explain_why · 380ms", "verify · 1ms"].map((t) => (
                    <span
                      key={t}
                      className="rounded-full px-3 py-1 text-[11px]"
                      style={{ background: "var(--l-paper-2)", color: "var(--l-ink-2)" }}
                    >
                      {t}
                    </span>
                  ))}
                </div>

                <div className="mt-5 space-y-2">
                  {EVIDENCE.map((e, i) => (
                    <div
                      key={e.loc}
                      className="rounded-lg p-3"
                      style={{
                        background: "var(--l-paper-2)",
                        border: "1px solid var(--l-rule)",
                        opacity: 0.18 + 0.82 * map(chips, i * 0.22, i * 0.22 + 0.4, 0, 1),
                        transform: `translateY(${(1 - map(chips, i * 0.22, i * 0.22 + 0.4, 0, 1)) * 10}px)`,
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span style={{ color: "var(--l-rust)" }}>{ICON[e.type]}</span>
                        <span
                          className="font-mono text-[11px]"
                          style={{ color: "var(--l-muted)" }}
                        >
                          {e.loc}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[12px]" style={{ color: "var(--l-ink-2)" }}>
                        {e.txt}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
