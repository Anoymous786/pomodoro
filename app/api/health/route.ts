import { NextResponse } from "next/server";

/**
 * Container / ALB health probe target.
 *
 * Deliberately dependency-free: no DB, no external calls — answers only
 * "is the Next.js server up and serving?". Kept dynamic so the response
 * timestamp is never cached at build time.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { status: "ok", timestamp: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } }
  );
}