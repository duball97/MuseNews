"use client";

import { useState } from "react";
import { TOKEN_CA, shortCa } from "@/lib/token";

export function ContractAddress({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(TOKEN_CA);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore */
    }
  };

  return (
    <button
      type="button"
      className={`ca-chip${className ? ` ${className}` : ""}`}
      onClick={copy}
      aria-label={`Copy contract address ${TOKEN_CA}`}
      title={TOKEN_CA}
    >
      <span className="ca-chip-label">CA</span>
      <span className="ca-chip-addr">{shortCa()}</span>
      <span className="ca-chip-status" aria-hidden="true">
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}
