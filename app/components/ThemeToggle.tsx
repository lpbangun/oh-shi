"use client";

import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function subscribeToTheme(onChange: () => void) {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/**
 * The theme is applied to <html> by an inline script before first paint. The
 * visible label still follows that attribute in CSS, while small client state
 * keeps the accessible action name in sync after hydration.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeToTheme, readTheme, () => "light");

  function toggle() {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("ohshi-theme", next);
    } catch {
      /* private browsing: the toggle still works for this session */
    }
  }

  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={`Switch to ${nextTheme} theme`}
      aria-pressed={theme === "dark"}
      onClick={toggle}
    >
      <span aria-hidden="true" className="when-light">Dark</span>
      <span aria-hidden="true" className="when-dark">Light</span>
    </button>
  );
}
