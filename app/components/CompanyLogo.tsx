"use client";

import { useState } from "react";

/**
 * Favicon from the employer's own domain, falling back to a monogram.
 * Shown to identify the employer whose posting we link to — nominative use.
 */
export function CompanyLogo({ domain, name }: { domain: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const monogram = name.slice(0, 2).toUpperCase();

  if (!domain || failed) {
    return <span className="logo"><span>{monogram}</span></span>;
  }
  return (
    <span className="logo">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
