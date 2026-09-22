import { existsSync } from "node:fs";
import { join } from "node:path";
import { uploadCover } from "@/lib/supabase";

const MUSE_LOOK =
  "the official Muse mascot: small round cream fuzzy marshmallow creature, stubby limbs, smooth beige face with tiny black bead eyes, soft pink blush cheeks, simple smile, soft 3D plush look";

async function stampMuse(coverBytes: Buffer) {
  const mascot = join(process.cwd(), "public", "brand", "muse-mascot.png");
  if (!existsSync(mascot)) return coverBytes;
  try {
    const sharp = (await import("sharp")).default;
    const muse = await sharp(mascot)
      .resize(340, 340, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    return await sharp(coverBytes)
      .resize(1024, 1024, { fit: "cover" })
      .composite([{ input: muse, gravity: "southeast", blend: "over" }])
      .png()
      .toBuffer();
  } catch {
    return coverBytes;
  }
}

/** Best-effort OpenRouter cover. Returns public URL or null. */
export async function generateArticleCover(slug: string, scene: string) {
  const key = (process.env.OPENROUTER_API_KEY || "").trim();
  if (!key) return null;

  let model = (process.env.OPENROUTER_IMAGE_MODEL || "").trim();
  if (!model) {
    const modelsResponse = await fetch("https://openrouter.ai/api/v1/images/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!modelsResponse.ok) return null;
    const models = await modelsResponse.json();
    model = models.data?.[0]?.id || "";
  }
  if (!model) return null;

  const response = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: `MuseNews cover art. Scene: ${scene.slice(0, 400)}. Feature ${MUSE_LOOK}. Soft cream palette, clean background, plush 3D character art. No readable text, no watermarks, no logos, square 1:1.`,
      size: "1024x1024",
      output_format: "png",
    }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  const encoded = data.data?.[0]?.b64_json;
  if (!encoded) return null;

  let bytes: Buffer = Buffer.from(encoded, "base64");
  bytes = Buffer.from(await stampMuse(bytes));
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return uploadCover(`covers/${slug}-${Date.now()}.png`, ab, "image/png");
}
