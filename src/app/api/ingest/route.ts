import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const secret = process.env.MUSENEWS_INGEST_SECRET || "";
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (secret && token !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const script = path.join(process.cwd(), "scripts", "ingest-musebook.mjs");
  const child = spawn(process.execPath, [script, "--no-covers"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  child.stdout.on("data", (d) => {
    out += d.toString();
  });
  child.stderr.on("data", (d) => {
    out += d.toString();
  });

  const code: number = await new Promise((resolve) => {
    child.on("close", (c) => resolve(c ?? 1));
  });

  return NextResponse.json({
    ok: code === 0,
    code,
    log: out.slice(-4000),
  });
}
