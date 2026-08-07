"use client";

import { useEffect, useId, useRef, useState } from "react";

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
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setOpen(false);
    };
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
    window.addEventListener("scroll", closeOnOutsideScroll, true);
    window.addEventListener("resize", closeOnOutsideScroll);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("scroll", closeOnOutsideScroll, true);
      window.removeEventListener("resize", closeOnOutsideScroll);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      menuRef.current
        ?.querySelector<HTMLButtonElement>(".col-menu-item.on, .col-menu-item")
        ?.focus({ preventScroll: true });
    }
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 240;
      const maxMenuHeight = Math.min(340, window.innerHeight - 16);
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const top =
        spaceBelow >= maxMenuHeight
          ? rect.bottom + 6
          : Math.max(8, rect.top - maxMenuHeight - 6);
      setCoords({
        left: Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - width - 10)),
        top,
      });
    }
    setOpen(true);
  }

  const active = filtering || Boolean(sortArrow);

  function moveFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(".col-menu-item") ?? []
    );
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "ArrowDown") next = current < items.length - 1 ? current + 1 : 0;
    else if (event.key === "ArrowUp") next = current > 0 ? current - 1 : items.length - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    } else return;
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`col-button${active ? " active" : ""}${className ? ` ${className}` : ""}`}
        aria-label={`${label} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
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
          id={menuId}
          className="col-menu"
          role="menu"
          aria-label={`${label} options`}
          style={{ left: coords.left, top: coords.top }}
          onKeyDown={moveFocus}
        >
          {groups.map((group, index) => (
            <div key={group.heading}>
              {index > 0 ? <hr aria-hidden="true" /> : null}
              <div className="col-menu-section">{group.heading}</div>
              {group.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.selected}
                  aria-label={`${group.heading}: ${option.label}`}
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
