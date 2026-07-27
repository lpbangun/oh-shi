"use client";

/**
 * The theme is applied to <html> by an inline script before first paint, so
 * React never owns it. The label is chosen by CSS from the same attribute,
 * which keeps this component stateless and free of hydration mismatch.
 */
export function ThemeToggle() {
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

  return (
    <button className="theme-toggle" type="button" onClick={toggle}>
      <span className="sr-only">Switch colour theme</span>
      <span aria-hidden="true" className="when-light">Dark</span>
      <span aria-hidden="true" className="when-dark">Light</span>
    </button>
  );
}
