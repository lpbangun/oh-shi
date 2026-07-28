"use client";

import { useEffect, useState } from "react";
import type { Company } from "@/lib/types";

/** Milliseconds until the next :30 UTC run in the six-hour schedule. */
function untilNextRun(now: Date) {
  const slotHour = Math.floor(now.getUTCHours() / 6) * 6;
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), slotHour, 30, 0)
  );
  if (next.getTime() <= now.getTime()) next.setUTCHours(next.getUTCHours() + 6);
  return next.getTime() - now.getTime();
}

function Countdown() {
  // Rendered only after mount: a clock in server HTML would hydrate stale.
  const [label, setLabel] = useState("NEXT RUN · EVERY 6H");
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
  return <span className="ticker-next">{label}</span>;
}

export function Ticker({ companies, deltas }: { companies: Company[]; deltas: Record<string, number> }) {
  const ranked = [...companies].sort((a, b) => b.hiringScore - a.hiringScore);
  if (ranked.length === 0) return null;

  // Duplicated so the marquee loops seamlessly at -50%.
  const lane = [...ranked, ...ranked];

  return (
    <div className="ticker" aria-hidden="true">
      <span className="ticker-label"><span className="live-dot" />Live</span>
      <div className="ticker-viewport">
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
