const url = () => (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const anonKey = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export function supabaseConfigured() {
  return Boolean(url() && (serviceKey() || anonKey()));
}

export async function supabaseRest(path: string, init: RequestInit = {}, { service = true } = {}) {
  const base = url();
  const key = service ? serviceKey() || anonKey() : anonKey() || serviceKey();
  if (!base || !key) throw new Error("Supabase is not configured");
  const extra = (init.headers || {}) as Record<string, string>;
  return fetch(`${base}/rest/v1${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...extra,
    },
  });
}

export async function uploadCover(path: string, bytes: ArrayBuffer, contentType: string) {
  const base = url();
  const key = serviceKey();
  if (!base || !key) throw new Error("SUPABASE_SERVICE_ROLE_KEY required for cover upload");
  const authHeaders = { apikey: key, Authorization: `Bearer ${key}` };
  const tryBuckets = ["musenews_covers", "musefi_covers"];

  for (const bucket of tryBuckets) {
    const existing = await fetch(`${base}/storage/v1/bucket/${bucket}`, { headers: authHeaders, cache: "no-store" });
    const missing = existing.status === 404 || existing.status === 400;
    if (missing && bucket === "musenews_covers") {
      await fetch(`${base}/storage/v1/bucket`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          id: bucket,
          name: bucket,
          public: true,
          fileSizeLimit: 5_242_880,
          allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
        }),
      });
    } else if (missing) {
      continue;
    }

    const objectKey = bucket === "musefi_covers" ? `musenews/${path}` : path;
    const objectPath = objectKey.split("/").map(encodeURIComponent).join("/");
    const res = await fetch(`${base}/storage/v1/object/${bucket}/${objectPath}`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": contentType, "x-upsert": "true" },
      body: bytes,
    });
    if (res.ok) return `${base}/storage/v1/object/public/${bucket}/${objectPath}`;
  }
  throw new Error("Cover upload failed");
}
