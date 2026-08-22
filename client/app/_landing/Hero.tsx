"use client";

import Link from "next/link";
import { useRef } from "react";
import { map, useSectionProgress, useSignedIn } from "./scroll";

/**
 * The focus pull. Borrowed straight from the camera metaphor: the page opens
 * out of focus and the first stretch of scroll racks it in — blur, scale and
 * a ghost word behind the mark all driven off one progress value, so they
 * can never drift out of sync with each other.
 */
export default function Hero() {
  const ref = useRef<HTMLDivElement>(null);
  const p = useSectionProgress(ref);
  const signedIn = useSignedIn();

  const blur = map(p, 0, 0.5, 26, 0);
  const scale = map(p, 0, 0.5, 1.14, 1);
  const copy = map(p, 0.36, 0.68, 0, 1); // supporting copy arrives after focus lands
  const ghost = map(p, 0, 1, 40, -70);

  return (
    <div ref={ref} className="relative" style={{ height: "175vh" }}>
      <div className="sticky top-0 h-screen overflow-hidden">
        {/* ghost display word, drifting slower than the page */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center select-none"
          style={{ transform: `translateY(${ghost}px)` }}
        >
          <span
            className="italic leading-none"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(150px, 26vw, 400px)",
              color: "rgba(28,25,23,.045)",
              letterSpacing: "-0.02em",
            }}
          >
            evidence
          </span>
        </div>

        {/* faint plate rings, the syftly paper furniture */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 -top-40 h-[560px] w-[560px] rounded-full"
          style={{ border: "1px solid rgba(180,83,9,.10)" }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-72 -left-56 h-[680px] w-[680px] rounded-full"
          style={{ border: "1px solid rgba(28,25,23,.05)" }}
        />

        <div
          className="relative mx-auto flex h-full max-w-6xl flex-col justify-center px-6 md:px-10"
        >
          <div className="flex items-center gap-4">
            <span className="h-px w-10" style={{ background: "var(--l-rust)" }} />
            <span
              className="text-[11px] tracking-[0.3em] uppercase"
              style={{ color: "var(--l-muted)" }}
            >
              Photon — build no. 001
            </span>
            <span className="h-px flex-1" style={{ background: "var(--l-rule)" }} />
          </div>

          <h1
            className="mt-7 italic leading-[0.85]"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(72px, 11.5vw, 176px)",
              color: "var(--l-ink)",
              filter: `blur(${blur}px)`,
              transform: `scale(${scale})`,
              transformOrigin: "left center",
              letterSpacing: "-0.015em",
            }}
          >
            photon
          </h1>

          <div style={{ opacity: copy, transform: `translateY(${(1 - copy) * 18}px)` }}>
            <div
              className="mt-8 space-y-1 text-[clamp(20px,2.6vw,32px)] leading-[1.28]"
              style={{ color: "var(--l-ink)" }}
            >
              <p>Answers from evidence.</p>
              <p>
                Never from{" "}
                <span style={{ fontFamily: "var(--font-display)", fontStyle: "italic" }}>
                  memory
                </span>
                .
              </p>
              <p style={{ color: "var(--l-muted)" }}>Live, on the call.</p>
            </div>

            <p
              className="mt-7 max-w-xl text-[15px] leading-relaxed"
              style={{ color: "var(--l-ink-2)" }}
            >
              A company brain that joins your customer calls, reads your code, docs, Slack,
              Jira and tickets, and answers in about two seconds — with a citation behind
              every claim, or nothing at all.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href="/call"
                className="group rounded-full px-6 py-3 text-[13px] tracking-[0.16em] uppercase transition-transform hover:-translate-y-0.5"
                style={{ background: "var(--l-ink)", color: "var(--l-paper)" }}
              >
                Join a call
              </Link>
              <Link
                href={signedIn ? "/dashboard" : "/login"}
                className="rounded-full px-6 py-3 text-[13px] tracking-[0.16em] uppercase transition-colors"
                style={{ border: "1px solid var(--l-rule)", color: "var(--l-ink)" }}
              >
                {signedIn ? "Open dashboard" : "Connect your sources"}
              </Link>
            </div>
          </div>
        </div>

        <div
          className="absolute inset-x-0 bottom-8 flex flex-col items-center gap-3"
          style={{ opacity: map(p, 0, 0.2, 1, 0) }}
        >
          <span
            className="text-[10px] tracking-[0.34em] uppercase"
            style={{ color: "var(--l-muted)" }}
          >
            Scroll to focus
          </span>
          <span className="l-scroll-line" />
        </div>
      </div>
    </div>
  );
}
