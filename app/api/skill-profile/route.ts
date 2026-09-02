import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/skill-profile
 *
 * §13 remote sync (option 2: localStorage + remote). The client builds its
 * skill profile locally (works now) and, when isRemoteApi() is true, mirrors
 * the same data here. In the deployed stack this request lands on API Gateway
 * and is handled by the skill-profile Lambda writing to the EXISTING free-tier
 * DynamoDB table design (no new paid AWS service). This Next.js route is a
 * local passthrough/ack: it validates the payload and returns ok so local
 * development never 404s, without persisting anything new server-side in the
 * node environment.
 */
export async function GET() {
  // Local-dev passthrough: the deployed skill-profile Lambda reads the
  // `roadmaps` DynamoDB table (SKILL# items) and returns the user's persisted
  // profiles. In local node there is no DynamoDB, so acknowledge with an empty
  // list — the hook treats any non-ok / empty response as "keep localStorage".
  return NextResponse.json({ profiles: [] });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  // Accept a map of SkillProfile keyed by topic slug, or { profiles: [...] }.
  const profiles = Array.isArray(obj.profiles)
    ? obj.profiles
    : typeof obj === "object" && obj !== null && !obj.profiles
      ? Object.values(obj)
      : [];
  const ok =
    Array.isArray(profiles) && profiles.every((p) => isMinimalProfile(p));
  if (!ok) {
    return NextResponse.json(
      { error: "Invalid skill profile payload." },
      { status: 400 },
    );
  }
  // Local acknowledgement only; the deployed Lambda persists to DynamoDB.
  return NextResponse.json({ ok: true, saved: profiles.length });
}

function isMinimalProfile(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.topic === "string" &&
    typeof p.label === "string" &&
    typeof p.score === "number"
  );
}
