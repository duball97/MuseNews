"use client";

import { useState } from "react";

export function ShareArticle({
  title,
  dek,
  url,
}: {
  title: string;
  dek?: string | null;
  url: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "shared">("idle");

  const text = dek?.trim() ? `${title} — ${dek}` : title;

  const mark = (next: "copied" | "shared") => {
    setStatus(next);
    window.setTimeout(() => setStatus("idle"), 1800);
  };

  const shareNative = async () => {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title, text, url });
        mark("shared");
        return;
      } catch {
        /* fall through to copy */
      }
    }
    await copyLink();
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard?.writeText(url);
      mark("copied");
    } catch {
      /* ignore */
    }
  };

  const tweetHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;

  return (
    <div className="share-bar" aria-label="Share this article">
      <span className="share-bar-label">Share</span>
      <button type="button" className="share-btn" onClick={shareNative}>
        Share story
      </button>
      <button type="button" className="share-btn" onClick={copyLink}>
        Copy link
      </button>
      <a className="share-btn" href={tweetHref} target="_blank" rel="noreferrer">
        Post on X
      </a>
      {status === "copied" ? <span className="share-bar-status">Link copied</span> : null}
      {status === "shared" ? <span className="share-bar-status">Shared</span> : null}
    </div>
  );
}
