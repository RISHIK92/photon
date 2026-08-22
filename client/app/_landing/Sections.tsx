"use client";

import Link from "next/link";
import { Reveal, RuleLabel, WordsReveal } from "./Reveal";

const FEATURES = [
  {
    k: "01",
    t: "It joins the call",
    d: "A real LiveKit participant with speech in and out. Poke the button or say its name and it takes the mic from whoever addressed it — which is also how it knows whose private sources may answer.",
  },
  {
    k: "02",
    t: "It reads the screen",
    d: "Share your screen and ask what you are looking at. The frame becomes citable evidence like anything else, and stale frames expire rather than describing a screen that closed twenty minutes ago.",
  },
  {
    k: "03",
    t: "It keeps the room",
    d: "Every call gets an eight-character code with no 0, O, 1, l or I in it — the first thing anyone does with a code is read it aloud. The code is the room, the link and the transcript.",
  },
  {
    k: "04",
    t: "It shows its work",
    d: "A live trace beside the captions: which tool is running right now, what it cost in milliseconds, which evidence card each citation chip resolves to.",
  },
  {
    k: "05",
    t: "It knows which repo",
    d: "Fifteen repositories in a workspace and no repo named in the question? Search runs across all of them and relevance decides — rather than silently answering about the wrong one.",
  },
  {
    k: "06",
    t: "It stays in its lane",
    d: "Workspaces are the tenant boundary. Every tool call is scoped by the server, never by the planner, so a hallucinated id is a dropped argument and not a cross-tenant read.",
  },
];

const SOURCES = ["GitHub", "Slack", "Jira", "Linear", "Notion", "Datadog", "Tickets", "Incidents", "Runbooks", "Commits"];

const RULES = [
  { n: "I", t: "No uncited claim", d: "If a sentence has no evidence id behind it, the verifier removes the sentence." },
  { n: "II", t: "Abstain over guess", d: "“I don't have evidence for that” is a correct answer. A confident wrong one is not." },
  { n: "III", t: "Never fabricate a locator", d: "An invented file path, line number, ticket id or Slack timestamp is a build-breaking bug, not a UI nit." },
];

export function Statement() {
  return (
    <section className="relative px-6 py-40 md:px-10 md:py-56">
      <div className="mx-auto max-w-4xl">
        <RuleLabel>The problem</RuleLabel>
        <WordsReveal
          text="The answer already exists. It is in a Slack thread from March, a commit message, a ticket nobody linked."
          serifWords={[2, 3]}
          className="mt-10 text-[clamp(28px,4.4vw,58px)] leading-[1.12]"
          stagger={32}
        />
        <Reveal delay={220}>
          <p
            className="mt-10 max-w-2xl text-[16px] leading-relaxed"
            style={{ color: "var(--l-ink-2)" }}
          >
            The person on the call does not have three minutes to find it, and the LLM that
            has read none of it will happily invent something that sounds right. Photon
            looks it up while you are still talking, and shows you exactly where it came
            from.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

export function Features() {
  return (
    <section className="relative px-6 py-32 md:px-10 md:py-44">
      <div className="mx-auto max-w-6xl">
        <RuleLabel>Capabilities</RuleLabel>
        <div className="mt-16 grid gap-x-12 gap-y-16 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <Reveal key={f.k} delay={(i % 3) * 110}>
              <div className="group">
                <div
                  className="h-px w-full origin-left scale-x-100 transition-transform duration-700"
                  style={{ background: "var(--l-rule)" }}
                />
                <div
                  className="mt-5 text-[11px] tracking-[0.24em] uppercase"
                  style={{ color: "var(--l-rust)" }}
                >
                  {f.k}
                </div>
                <h3
                  className="mt-4 text-[24px] leading-tight"
                  style={{ color: "var(--l-ink)" }}
                >
                  {f.t}
                </h3>
                <p
                  className="mt-3 text-[14px] leading-relaxed"
                  style={{ color: "var(--l-ink-2)" }}
                >
                  {f.d}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Sources() {
  const row = [...SOURCES, ...SOURCES];
  return (
    <section id="sources" className="relative overflow-hidden py-28">
      <div className="px-6 md:px-10">
        <div className="mx-auto max-w-6xl">
          <RuleLabel>Connected sources</RuleLabel>
        </div>
      </div>
      <div className="mt-12 flex" style={{ maskImage: "linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent)", WebkitMaskImage: "linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent)" }}>
        <div className="l-marquee flex shrink-0 gap-14 pr-14">
          {row.map((s, i) => (
            <span
              key={i}
              className="whitespace-nowrap italic leading-none"
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "clamp(44px,6vw,84px)",
                color: i % 3 === 0 ? "var(--l-ink)" : "rgba(28,25,23,.22)",
              }}
            >
              {s}
            </span>
          ))}
        </div>
        <div className="l-marquee flex shrink-0 gap-14 pr-14" aria-hidden>
          {row.map((s, i) => (
            <span
              key={i}
              className="whitespace-nowrap italic leading-none"
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "clamp(44px,6vw,84px)",
                color: i % 3 === 0 ? "var(--l-ink)" : "rgba(28,25,23,.22)",
              }}
            >
              {s}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-12 px-6 md:px-10">
        <Reveal>
          <p
            className="mx-auto max-w-2xl text-center text-[15px] leading-relaxed"
            style={{ color: "var(--l-ink-2)" }}
          >
            Point it at the repositories you choose, the channels you pick and the projects
            that matter. Read-only scopes, credentials encrypted at rest, and nothing
            indexed that you did not select.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

export function Rules() {
  return (
    <section id="rules" className="relative px-6 py-32 md:px-10 md:py-44">
      <div className="mx-auto max-w-5xl">
        <RuleLabel>Three rules it cannot break</RuleLabel>
        <div className="mt-16 space-y-px">
          {RULES.map((r, i) => (
            <Reveal key={r.n} delay={i * 130}>
              <div
                className="grid items-baseline gap-6 border-t py-10 md:grid-cols-[80px_1fr_1.2fr]"
                style={{ borderColor: "var(--l-rule)" }}
              >
                <span
                  className="italic leading-none"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: 44,
                    color: "var(--l-rust)",
                  }}
                >
                  {r.n}
                </span>
                <h3 className="text-[26px] leading-tight" style={{ color: "var(--l-ink)" }}>
                  {r.t}
                </h3>
                <p className="text-[15px] leading-relaxed" style={{ color: "var(--l-ink-2)" }}>
                  {r.d}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Closing() {
  return (
    <section className="relative overflow-hidden px-6 py-44 md:px-10">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[720px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ border: "1px solid rgba(180,83,9,.12)" }}
      />
      <div className="relative mx-auto max-w-3xl text-center">
        <Reveal>
          <p
            className="italic leading-[0.9]"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(64px,11vw,150px)",
              color: "var(--l-ink)",
            }}
          >
            ask it live
          </p>
        </Reveal>
        <Reveal delay={140}>
          <p
            className="mx-auto mt-8 max-w-lg text-[16px] leading-relaxed"
            style={{ color: "var(--l-ink-2)" }}
          >
            Open a room, share the code, and let it listen. Or connect your sources first
            and see what it can already answer.
          </p>
        </Reveal>
        <Reveal delay={240}>
          <div className="mt-12 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/call"
              className="rounded-full px-7 py-3.5 text-[13px] tracking-[0.16em] uppercase transition-transform hover:-translate-y-0.5"
              style={{ background: "var(--l-ink)", color: "var(--l-paper)" }}
            >
              Join a call
            </Link>
            <Link
              href="/login"
              className="rounded-full px-7 py-3.5 text-[13px] tracking-[0.16em] uppercase"
              style={{ border: "1px solid var(--l-rule)", color: "var(--l-ink)" }}
            >
              Connect your sources
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="px-6 pb-14 md:px-10">
      <div
        className="mx-auto flex max-w-6xl flex-col gap-6 border-t pt-10 md:flex-row md:items-center md:justify-between"
        style={{ borderColor: "var(--l-rule)" }}
      >
        <span
          className="text-[26px] italic leading-none"
          style={{ fontFamily: "var(--font-display)", color: "var(--l-ink)" }}
        >
          photon
        </span>
        <div className="flex flex-wrap gap-6">
          {[
            ["Join a call", "/call"],
            ["Dashboard", "/dashboard"],
            ["Sign in", "/login"],
          ].map(([l, h]) => (
            <Link
              key={h}
              href={h}
              className="text-[12px] tracking-[0.16em] uppercase"
              style={{ color: "var(--l-muted)" }}
            >
              {l}
            </Link>
          ))}
        </div>
        <span
          className="text-[11px] tracking-[0.22em] uppercase"
          style={{ color: "var(--l-muted)" }}
        >
          Company brain · live call support
        </span>
      </div>
    </footer>
  );
}
