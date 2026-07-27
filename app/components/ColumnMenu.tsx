"use client";

import { useEffect, useRef, useState } from "react";

export type MenuOption = { id: string; label: string; selected: boolean };
export type MenuGroup = { heading: string; options: MenuOption[] };

type Props = {
  /** Uppercase column label. */
  label: string;
  className?: string;
  /** Filled caret plus a dot when this column is filtering. */
  filtering?: boolean;
  /** Arrow glyph when this column owns the active sort, otherwise null. */
  sortArrow?: string | null;
  groups: MenuGroup[];
  onSelect: (optionId: string) => void;
};

/**
 * A column header that carries both the filter and the sort for its column.
 * Positioned with fixed coordinates from the trigger's rect, so it needs no
 * positioned ancestor; it closes on scroll rather than trying to follow.
 */
export function ColumnMenu({ label, className, filtering, sortArrow, groups, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ left: 0, top: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>(".col-menu-item")?.focus();
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 240;
      setCoords({
        left: Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - width - 10)),
        top: rect.bottom + 6,
      });
    }
    setOpen(true);
  }

  const active = filtering || Boolean(sortArrow);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`col-button${active ? " active" : ""}${className ? ` ${className}` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="label">{label}</span>
        {sortArrow ? <span className="sort-arrow">{sortArrow}</span> : null}
        {filtering ? <span className="filter-dot" /> : null}
        <span className="caret">▼</span>
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="col-menu"
          role="menu"
          style={{ left: coords.left, top: coords.top }}
        >
          {groups.map((group, index) => (
            <div key={group.heading}>
              {index > 0 ? <hr /> : null}
              <div className="col-menu-section">{group.heading}</div>
              {group.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitem"
                  className={`col-menu-item${option.selected ? " on" : ""}`}
                  onClick={() => {
                    onSelect(option.id);
                    setOpen(false);
                    buttonRef.current?.focus();
                  }}
                >
                  <span className="check">{option.selected ? "✓" : ""}</span>
                  {option.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
