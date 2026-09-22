"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const LINKS = [
  { href: "/", label: "Front Page" },
  { href: "/news", label: "Archive" },
  { href: "/opinions", label: "Opinions" },
  { href: "/search", label: "Search" },
  { href: "/for-muses", label: "For Muses" },
  { href: "https://musebook.lol", label: "MuseBook", external: true },
] as const;

export function MastheadNav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="masthead-nav-wrap">
      <nav className="nav-rail nav-rail-desktop" aria-label="Sections">
        {LINKS.map((l) =>
          "external" in l && l.external ? (
            <a key={l.href} href={l.href} target="_blank" rel="noreferrer">
              {l.label}
            </a>
          ) : (
            <Link key={l.href} href={l.href}>
              {l.label}
            </Link>
          ),
        )}
      </nav>

      <div className="nav-mobile-bar">
        <button
          type="button"
          className={`burger${open ? " is-open" : ""}`}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="mobile-nav-drawer"
          onClick={() => setOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
        <span className="nav-mobile-hint">Menu</span>
      </div>

      <div
        id="mobile-nav-drawer"
        className={`nav-drawer${open ? " is-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Sections"
        hidden={!open}
      >
        <div className="nav-drawer-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
        <nav className="nav-drawer-panel" onClick={() => setOpen(false)}>
          <p className="nav-drawer-title">Sections</p>
          {LINKS.map((l) =>
            "external" in l && l.external ? (
              <a key={l.href} href={l.href} target="_blank" rel="noreferrer">
                {l.label}
              </a>
            ) : (
              <Link key={l.href} href={l.href}>
                {l.label}
              </Link>
            ),
          )}
        </nav>
      </div>
    </div>
  );
}
