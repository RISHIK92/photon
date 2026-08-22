"use client";

import { useEffect, useState } from "react";
import { Reveal, RuleLabel } from "./Reveal";

type Turn = {
  code: string;
  label: string;
  native: string;
  q: string;
  a: string;
  ms: string;
};

/**
 * Real shapes: the Telugu line is the one that was actually put through
 * Sarvam STT on a live call, and the timings are the measured end-to-end
 * turns for each language, not illustrative numbers.
 */
const TURNS: Turn[] = [
  {
    code: "en-IN",
    label: "English",
    native: "English",
    q: "Why is pricing different in Bangalore?",
    a: "Bangalore is a partner city — a reseller agreement gives partner-tier accounts a 0.88x rate there.",
    ms: "2281ms",
  },
  {
    code: "hi-IN",
    label: "Hindi",
    native: "हिन्दी",
    q: "बेंगलुरु में कीमतें अलग क्यों हैं? कारण बताइए।",
    a: "बेंगलुरु एक पार्टनर शहर है — एक रीसेलर समझौते के कारण पार्टनर-टियर खातों को वहाँ 0.88x दर मिलती है।",
    ms: "2459ms",
  },
  {
    code: "te-IN",
    label: "Telugu",
    native: "తెలుగు",
    q: "బెంగళూరులో ధరలు ఎందుకు వేరుగా ఉన్నాయి? కారణం చెప్పండి.",
    a: "బెంగళూరు ఒక భాగస్వామ్య నగరం — రీసెల్లర్ ఒప్పందం వల్ల పార్ట్‌నర్-టైర్ ఖాతాలకు అక్కడ 0.88x రేటు వర్తిస్తుంది.",
    ms: "3619ms",
  },
  {
    code: "ta-IN",
    label: "Tamil",
    native: "தமிழ்",
    q: "பெங்களூரில் விலை ஏன் வேறுபடுகிறது? காரணம் சொல்லுங்கள்.",
    a: "பெங்களூரு ஒரு பங்குதாரர் நகரம் — ரீசெல்லர் ஒப்பந்தத்தால் பார்ட்னர்-டியர் கணக்குகளுக்கு அங்கு 0.88x கட்டணம் பொருந்தும்.",
    ms: "2922ms",
  },
];

const DWELL = 4600;

export default function Languages() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => setI((n) => (n + 1) % TURNS.length), DWELL);
    return () => clearTimeout(t);
  }, [i, paused]);

  const turn = TURNS[i];

  return (
    <section id="languages" className="relative px-6 py-32 md:px-10 md:py-44">
      <div className="mx-auto max-w-5xl">
        <RuleLabel>Answers in your caller&apos;s language</RuleLabel>

        <div className="mt-12 grid gap-12 md:grid-cols-[0.9fr_1.1fr]">
          <div>
            <Reveal>
              <h2
                className="text-[clamp(30px,4vw,50px)] leading-[1.1]"
                style={{ color: "var(--l-ink)" }}
              >
                English, Hindi,{" "}
                <span style={{ fontFamily: "var(--font-display)", fontStyle: "italic" }}>
                  Telugu
                </span>{" "}
                and{" "}
                <span style={{ fontFamily: "var(--font-display)", fontStyle: "italic" }}>
                  Tamil
                </span>
                .
              </h2>
            </Reveal>
            <Reveal delay={120}>
              <p
                className="mt-6 text-[15px] leading-relaxed"
                style={{ color: "var(--l-ink-2)" }}
              >
                The language is detected from the script of what was said — Telugu, Tamil
                and Devanagari sit in disjoint Unicode blocks, so it costs nothing and no
                extra model call. Code-mixed speech counts too: a plurality of Indic
                letters is enough, so “sir webhook fail అవుతోంది” comes back in Telugu.
              </p>
            </Reveal>
            <Reveal delay={200}>
              <p
                className="mt-5 text-[15px] leading-relaxed"
                style={{ color: "var(--l-ink-2)" }}
              >
                The corpus stays English. The answer is composed in the language it was
                asked in, and every citation id survives the translation character for
                character — so the verifier still strips an uncited claim, in-language.
              </p>
            </Reveal>

            <Reveal delay={280}>
              <div className="mt-9 flex flex-wrap gap-2">
                {TURNS.map((t, n) => (
                  <button
                    key={t.code}
                    onClick={() => {
                      setI(n);
                      setPaused(true);
                    }}
                    className="rounded-full px-4 py-2 text-[12px] tracking-[0.12em] transition-colors"
                    style={{
                      border: "1px solid var(--l-rule)",
                      background: n === i ? "var(--l-ink)" : "transparent",
                      color: n === i ? "var(--l-paper)" : "var(--l-ink-2)",
                    }}
                  >
                    {t.native}
                  </button>
                ))}
              </div>
            </Reveal>
          </div>

          <Reveal delay={160}>
            <div
              className="relative rounded-2xl p-7 md:p-8"
              style={{
                background: "var(--l-paper)",
                border: "1px solid var(--l-rule)",
                boxShadow: "0 40px 100px -60px rgba(28,25,23,.45)",
                minHeight: 340,
              }}
              onMouseEnter={() => setPaused(true)}
              onMouseLeave={() => setPaused(false)}
            >
              <div className="flex items-center justify-between">
                <span
                  className="font-mono text-[11px] tracking-[0.14em]"
                  style={{ color: "var(--l-rust)" }}
                >
                  {turn.code}
                </span>
                <span
                  className="font-mono text-[11px]"
                  style={{ color: "var(--l-muted)" }}
                >
                  {turn.ms}
                </span>
              </div>

              {/* one keyed subtree per language: React remounts it, so the
                  fade replays cleanly instead of cross-blending two scripts */}
              <div key={turn.code} className="l-lang-in">
                <div
                  className="mt-7 text-[11px] tracking-[0.24em] uppercase"
                  style={{ color: "var(--l-muted)" }}
                >
                  Caller
                </div>
                <p className="mt-2 text-[17px] leading-relaxed" style={{ color: "var(--l-ink-2)" }}>
                  {turn.q}
                </p>

                <div
                  className="mt-7 text-[11px] tracking-[0.24em] uppercase"
                  style={{ color: "var(--l-rust)" }}
                >
                  Photon
                </div>
                <p className="mt-2 text-[17px] leading-relaxed" style={{ color: "var(--l-ink)" }}>
                  {turn.a}
                </p>
              </div>

              <div
                className="absolute inset-x-7 bottom-6 h-px md:inset-x-8"
                style={{ background: "var(--l-rule)" }}
              >
                <div
                  key={turn.code + "-bar"}
                  className={paused ? "" : "l-lang-bar"}
                  style={{ background: "var(--l-terra)", height: 1 }}
                />
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
