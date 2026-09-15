"use client";

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import type { Company } from "@/lib/types";

/** Milliseconds until the next :30 UTC run in the two-hour schedule. */
function untilNextRun(now: Date) {
  const slotHour = Math.floor(now.getUTCHours() / 2) * 2;
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), slotHour, 30, 0)
  );
  if (next.getTime() <= now.getTime()) next.setUTCHours(next.getUTCHours() + 2);
  return next.getTime() - now.getTime();
}

function Countdown() {
  // Rendered only after mount: a clock in server HTML would hydrate stale.
  const [label, setLabel] = useState("NEXT RUN · EVERY 2H");
  useEffect(() => {
    const tick = () => {
      const remaining = Math.max(0, Math.floor(untilNextRun(new Date()) / 1000));
      const pad = (value: number) => String(value).padStart(2, "0");
      setLabel(`NEXT RUN ${pad(Math.floor(remaining / 3600))}:${pad(Math.floor((remaining % 3600) / 60))}:${pad(remaining % 60)}`);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="ticker-next" aria-hidden="true">{label}</span>;
}

export function Ticker({ companies, deltas }: { companies: Company[]; deltas: Record<string, number> }) {
  const [paused, setPaused] = useState(false);
  const ranked = [...companies].sort((a, b) => b.hiringScore - a.hiringScore);
  if (ranked.length === 0) return null;

  // Duplicated so the marquee loops seamlessly at -50%.
  const lane = [...ranked, ...ranked];
  // Keep the reading speed stable as the company list grows. At roughly twelve
  // seconds per card, names and all three metrics remain comfortably legible.
  const tickerStyle = {
    "--ticker-duration": `${Math.max(180, ranked.length * 12)}s`,
  } as CSSProperties;

  return (
    <div
      className={`ticker${paused ? " paused" : ""}`}
      role="region"
      aria-label="Live hiring activity"
      style={tickerStyle}
    >
      <button
        type="button"
        className="ticker-label ticker-toggle"
        aria-label={paused ? "Resume live ticker" : "Pause live ticker"}
        aria-pressed={paused}
        onClick={() => setPaused((value) => !value)}
      >
        <span className="live-dot" aria-hidden="true" />
        <span>Live</span>
        <span className="ticker-control" aria-hidden="true">{paused ? "▶" : "Ⅱ"}</span>
      </button>
      <div className="ticker-viewport" aria-hidden="true">
        <div className="ticker-track">
          {lane.map((company, index) => {
            const delta = deltas[company.id] || 0;
            const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
            const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "—";
            return (
              <span className="ticker-item" key={`${company.id}-${index}`}>
                <b>{company.name.toUpperCase()}</b>
                <span>{company.openJobCount} {company.openJobCount === 1 ? "role" : "roles"}</span>
                <span className={direction}>{arrow} {delta > 0 ? "+" : ""}{delta}</span>
                <span className="flat">sig {company.hiringScore}</span>
              </span>
            );
          })}
        </div>
      </div>
      <Countdown />
    </div>
  );
}
