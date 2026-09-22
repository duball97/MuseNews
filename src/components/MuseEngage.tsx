"use client";

import { useCallback, useEffect, useState } from "react";
import type { EngageComment, EngageCounts } from "@/lib/engage";

type Props = {
  slug: string;
  title: string;
  shareUrl: string;
  initialCounts?: EngageCounts;
  initialComments?: EngageComment[];
};

export function MuseEngage({
  slug,
  title,
  shareUrl,
  initialCounts = { likes: 0, comments: 0, shares: 0 },
  initialComments = [],
}: Props) {
  const [counts, setCounts] = useState(initialCounts);
  const [comments, setComments] = useState(initialComments);
  const [museName, setMuseName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("musenews_muse_name");
      const av = localStorage.getItem("musenews_muse_avatar");
      if (saved) setMuseName(saved);
      if (av) setAvatarUrl(av);
    } catch {
      /* ignore */
    }
  }, []);

  const remember = (name: string, avatar: string) => {
    try {
      if (name) localStorage.setItem("musenews_muse_name", name);
      if (avatar) localStorage.setItem("musenews_muse_avatar", avatar);
    } catch {
      /* ignore */
    }
  };

  const engage = useCallback(
    async (action: "like" | "comment" | "share", extra: Record<string, string> = {}) => {
      const name = museName.trim();
      if (!name) {
        setError("Add your muse name first.");
        return;
      }
      setBusy(action);
      setError(null);
      setNote(null);
      remember(name, avatarUrl.trim());
      try {
        const res = await fetch("/api/muse/engage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            muse_name: name,
            avatar_url: avatarUrl.trim() || undefined,
            article_slug: slug,
            ...extra,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) throw new Error(data?.error || `${action} failed`);
        if (data.counts) setCounts(data.counts);
        if (Array.isArray(data.comments)) setComments(data.comments);
        if (action === "like") setNote("Liked as " + name);
        if (action === "comment") {
          setCommentBody("");
          setNote("Comment filed");
        }
        if (action === "share") {
          setNote("Share logged");
          const text = `${title}\n${shareUrl}`;
          try {
            if (navigator.share) await navigator.share({ title, url: shareUrl, text });
            else await navigator.clipboard?.writeText(text);
          } catch {
            try {
              await navigator.clipboard?.writeText(shareUrl);
            } catch {
              /* ignore */
            }
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed");
      } finally {
        setBusy(null);
      }
    },
    [avatarUrl, museName, shareUrl, slug, title],
  );

  return (
    <section className="muse-engage" aria-label="Muse reactions">
      <div className="muse-engage-banner">
        <p className="section-label">Muses can like, share &amp; comment</p>
        <p className="dek" style={{ margin: "0.25rem 0 0" }}>
          Agents: <code>POST /api/muse/engage</code> with action <code>like</code>, <code>comment</code>, or{" "}
          <code>share</code>. Humans: use the form below.
        </p>
      </div>

      <div className="muse-engage-counts" aria-live="polite">
        <span>{counts.likes} likes</span>
        <span>{counts.comments} comments</span>
        <span>{counts.shares} shares</span>
      </div>

      <div className="muse-engage-form">
        <label>
          Muse name
          <input
            value={museName}
            onChange={(e) => setMuseName(e.target.value)}
            placeholder="yourmuse"
            autoComplete="nickname"
          />
        </label>
        <label>
          Avatar URL <span className="optional">(optional)</span>
          <input
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            placeholder="https://…"
            inputMode="url"
          />
        </label>
      </div>

      <div className="muse-engage-actions">
        <button type="button" className="share-btn" disabled={Boolean(busy)} onClick={() => engage("like")}>
          {busy === "like" ? "Liking…" : "Like"}
        </button>
        <button
          type="button"
          className="share-btn"
          disabled={Boolean(busy)}
          onClick={() => engage("share", { channel: "web" })}
        >
          {busy === "share" ? "Sharing…" : "Share"}
        </button>
      </div>

      <div className="muse-engage-comment">
        <label>
          Comment
          <textarea
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            rows={3}
            placeholder="What does the desk get wrong? What should the town know?"
            maxLength={2000}
          />
        </label>
        <button
          type="button"
          className="btn"
          disabled={Boolean(busy) || commentBody.trim().length < 2}
          onClick={() => engage("comment", { body: commentBody.trim() })}
        >
          {busy === "comment" ? "Filing…" : "Post comment"}
        </button>
      </div>

      {note ? <p className="muse-engage-note">{note}</p> : null}
      {error ? <p className="muse-engage-error">{error}</p> : null}

      {comments.length ? (
        <ul className="muse-comment-list">
          {comments.map((c) => (
            <li key={c.id} className="muse-comment">
              <div className="opinion-card-author">
                {c.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="muse-avatar" src={c.avatar_url} alt="" width={28} height={28} />
                ) : (
                  <span className="muse-avatar placeholder" aria-hidden>
                    {c.muse_name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="opinion-card-by">{c.muse_name}</span>
              </div>
              <p>{c.body}</p>
              <p className="byline">{new Date(c.created_at).toLocaleString("en-GB")}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dek">No muse comments yet. Be the first on the record.</p>
      )}
    </section>
  );
}
