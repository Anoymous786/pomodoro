import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, BadgeCheck } from "lucide-react";

export const metadata: Metadata = {
  title: "Architecture — Pomodoro Focus Dashboard",
  description:
    "Deployed on the AWS always-free tier: API Gateway, Lambda, DynamoDB, S3, SQS, SNS.",
};

/**
 * /architecture — static, dependency-free stack diagram.
 * Plain SVG + styled boxes (no diagramming library) so it adds no JS bundle
 * weight and renders offline once cached by the service worker.
 */

const W = 168; // node width
const H = 44; // node height
const COLS = [100, 315, 530, 745]; // tier x-centers

interface Box {
  x: number;
  y: number;
  label: string;
  sub?: string;
  fill: string;
  stroke: string;
}

const box = (
  cx: number,
  y: number,
  label: string,
  sub: string | undefined,
  fill: string,
  stroke: string
): Box => ({ x: cx - W / 2, y, label, sub, fill, stroke });

/** Row 1 — entry path. */
const frontend = box(COLS[0], 40, "Next.js Frontend", "static + local state", "#fee2e2", "#fca5a5");
const gateway = box(COLS[1], 40, "API Gateway (HTTP)", "routes · CORS · logs", "#e0f2fe", "#7dd3fc");

/** Row 2 — Lambda functions. */
const lambdas = [
  { name: "generate-roadmap", sub: "validates + enqueues" },
  { name: "roadmap-worker", sub: "LLM → DynamoDB" },
  { name: "intake · exams · replan", sub: "synchronous LLM calls" },
  { name: "uploads · focus-logs", sub: "presign · metrics" },
].map((fn, i) => ({ ...box(COLS[2], 150 + i * 58, fn.name, fn.sub, "#fef3c7", "#fcd34d") }));

/** Row 3 — data & messaging services. */
const stores = [
  { name: "DynamoDB", sub: "roadmaps · cache · focus" },
  { name: "S3", sub: "private resume uploads" },
  { name: "SQS", sub: "generation job queue" },
  { name: "SNS", sub: "'roadmap ready' events" },
].map((s, i) => ({ ...box(COLS[3], 150 + i * 58, s.name, s.sub, "#dcfce7", "#86efac") }));

/** One labelled SVG node. */
function Node({ b }: { b: Box }) {
  return (
    <g>
      <rect x={b.x} y={b.y} width={W} height={H} rx="10" fill={b.fill} stroke={b.stroke} />
      <text x={b.x + W / 2} y={b.y + (b.sub ? 18 : 26)} textAnchor="middle" className="fill-gray-900 text-[12px] font-semibold">
        {b.label}
      </text>
      {b.sub && (
        <text x={b.x + W / 2} y={b.y + 34} textAnchor="middle" className="fill-gray-500 text-[10px]">
          {b.sub}
        </text>
      )}
    </g>
  );
}

/** Curved connector between two tiers with an optional label. */
function Edge({ from, to, label }: { from: Box; to: Box; label?: string }) {
  const x1 = from.x + W;
  const y1 = from.y + H / 2;
  const x2 = to.x - 4;
  const y2 = to.y + H / 2;
  const mx = (x1 + x2) / 2;
  return (
    <g>
      <path
        d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
        fill="none"
        stroke="#9ca3af"
        strokeWidth="1.5"
        markerEnd="url(#arrow)"
      />
      {label && (
        <text x={mx} y={(y1 + y2) / 2 - 6} textAnchor="middle" className="fill-gray-400 text-[9px]">
          {label}
        </text>
      )}
    </g>
  );
}

export default function ArchitecturePage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/" className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 transition hover:text-habeet-600 dark:text-gray-400 dark:hover:text-habeet-400">
        <ArrowLeft className="h-4 w-4" />
        Back to dashboard
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 sm:text-3xl">Architecture</h1>
      <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
        Roadmap generation is asynchronous: the API Lambda enqueues an SQS job,
        a worker Lambda calls the LLM and writes the result to DynamoDB, then
        SNS fans out a &quot;roadmap ready&quot; event while the browser polls a
        status endpoint. Resume uploads go straight to S3 via pre-signed PUTs.
      </p>

      <div className="mt-8 overflow-x-auto rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <svg viewBox="0 0 840 400" className="min-w-[680px]" role="img" aria-label="Frontend to API Gateway to Lambda functions to data services flow">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-gray-400" />
            </marker>
          </defs>

          <Node b={frontend} />
          <Node b={gateway} />
          <Edge from={frontend} to={gateway} label="fetch() JSON over HTTPS" />

          {lambdas.map((fn) => (
            <g key={fn.label}>
              <Node b={fn} />
              <Edge from={gateway} to={fn} label="invoke" />
            </g>
          ))}

          {/* Worker -> SQS/SNS/DynamoDB; uploads -> S3; focus-logs -> DynamoDB */}
          {stores.map((s, i) => (
            <g key={s.label}>
              <Node b={s} />
              <Edge from={lambdas[i % lambdas.length]} to={s} />
            </g>
          ))}

          {/* CloudWatch band across the bottom */}
          <rect x={COLS[0] - W / 2} y={372} width={COLS[3] - COLS[0] + W} height={24} rx="8" fill="#f3e8ff" stroke="#d8b4fe" />
          <text x={(COLS[0] + COLS[3]) / 2} y={388} textAnchor="middle" className="fill-gray-700 text-[11px] font-medium">
            CloudWatch — logs + alarms on errors &amp; queue depth · IAM scopes each function to only what it touches
          </text>
        </svg>
      </div>

      <div className="mt-6 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-900/30">
        <BadgeCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
          Built entirely on AWS always-free tier — $0/month by design.
        </p>
      </div>
    </main>
  );
}