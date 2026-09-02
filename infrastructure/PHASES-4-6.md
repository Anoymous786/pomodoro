# Phases 4–6 — What was built, why, and what to test

---

## Phase 4 — SQS + SNS async roadmap generation
**Anchor:** `aws_sqs_queue.roadmap_jobs`

**Built.** `POST /api/generate-roadmap` no longer calls the LLM. It validates
input exactly as before, writes a `JOB#<id>` item (status PENDING, TTL 7 days)
to DynamoDB, enqueues `{jobId, userId}` to SQS (IDs only — the worker re-reads
the job so messages stay tiny and jobs stay auditable), and returns **202**
with a statusUrl. `roadmap-worker` consumes one message at a time:
idempotency check (READY -> skip; SQS is at-least-once) -> cache-aside lookup
in `llm_cache` -> on miss call Groq/Gemini and validate the roadmap schema ->
write the cache row with a 24h TTL -> **TransactWriteItems** storing the full
`ROADMAP#<id>` document AND flipping the job to READY atomically -> publish a
"roadmap ready" event to SNS. Failures mark the job FAILED (pollers get
closure), rethrow, and ReportBatchItemFailures retries only that message;
after 3 attempts it lands in the DLQ. The frontend (`generateRoadmapRemote`
in lib/api.ts) submits then polls `GET /api/roadmap-status/{jobId}` every
2.5s up to 120s — same roadmap object at the end, so state handling didn't
change.

**Why queue + poll over holding the socket open.** A 10-30s synchronous LLM
call is fragile (browser/proxy timeouts, double-submits on spinner) and pins
a Lambda doing nothing. The queue buys free retries, poison-message
isolation, backpressure for free-concurrency spikes, and a natural place to
observe depth/age as health signals.

**Test.**
```powershell
# enqueue
$job = curl.exe -s -X POST "$api/api/generate-roadmap" -H "content-type: application/json" `
  -d '{\"topic\":\"terraform\",\"context\":{\"level\":\"beginner\"}}' | ConvertFrom-Json
$job.jobId
# watch it flip PENDING -> READY (~15s)
curl.exe -s "$api/api/roadmap-status/$($job.jobId)"
# confirm SNS email arrived ("Roadmap ready: ..."), confirm SQS depth back to 0:
aws sqs get-queue-attributes --queue-url <jobs-url> --attribute-names ApproximateNumberOfMessagesVisible
```
Cache proof: run the SAME request twice — second worker log shows
`Cache HIT`, and `aws dynamodb scan --table-name pomodoro-dashboard-llm-cache`
shows the row with `expires_at ≈ now + 86400`.
Failure path: send a poison message manually
(`aws sqs send-message --queue-url <jobs> --message-body '{}'`) — after 3
tries it appears in the DLQ and the Phase-6 alarm fires.
UI test: generate from TopicBoard — button spins while status endpoint is
polled, roadmap renders exactly as before.

---

## Phase 5 — DynamoDB: state + search + cache
**Anchor:** `aws_dynamodb_table.roadmaps`

**Built.** Two PROVISIONED tables (2 RCU / 2 WCU each — inside DynamoDB's
PERMANENT always-free 25/25 + 25GB):
- `roadmaps`: PK `user_id`, SK `sk`. Item kinds: `JOB#<uuid>` (job lifecycle,
  TTL 7d) and `ROADMAP#<uuid>` (full document: topic_name, topic_lower,
  badge_reward, days with per-task manual_minutes/is_completed, status).
- `llm_cache`: PK `cache_key = sha256(provider|model|"roadmap"|stableJSON)`,
  response JSON, native TTL attribute `expires_at` = now + 24h. This IS the
  Redis replacement: identical topic+context within TTL returns instantly,
  costs zero LLM tokens, and self-deletes.
- `GET /api/search?topic=` scans roadmaps filtering `contains(topic_lower, q)`
  projecting summaries only; without `topic` it queries one user's roadmaps,
  newest first.

**Why this replaces localStorage/OpenSearch credibly.** localStorage dies with
the browser profile and can't feed server features; a single-table-per-domain
DynamoDB design gives durable multi-device truth with predictable single-digit-ms
access. Versus OpenSearch: substring Scan is honest below ~1k items, bills
fractions of one free RCU, and the upgrade ladder (GSI on topic_lower ->
managed OpenSearch behind the SAME endpoint contract) is written into the code
comments.

**Test.**
```powershell
# after two identical generations:
aws dynamodb scan --table-name pomodoro-dashboard-llm-cache --max-items 1
aws dynamodb query --table-name pomodoro-dashboard-roadmaps --no-paginate `
  --key-condition-expression "user_id = :u AND begins_with(sk,:p)" `
  --expression-attribute-values '{":u":{"S":"demo-user"},":p":{"S":"ROADMAP#"}}'
curl.exe -s "$api/api/search?topic=terraform"
```
UI: HistoryModal still shows past roadmaps across reloads/browser profiles
(state survives because DynamoDB is now source of truth for generated docs).

---

## Phase 6 — CloudWatch alarms + dashboard
**Anchor:** `aws_cloudwatch_metric_alarm.dlq_not_empty`

**Built.** Lambdas already write structured logs to 7-day-retention groups.
Added four alarms, all wired to the SAME SNS topic as roadmap-ready emails:
1. `worker-errors >= 3 / 5min x2` — LLM/DynamoDB failures visible
2. `jobs-backlog >= 5 visible / 5min x3` — worker stuck or throttled
3. `DLQ > 0` — poison message exhausted retries (page-worthy)
4. `API 5XXError >= 10 / 5min x2` — user-facing breakage
Plus one dashboard: invocations per function, API p50/p99 latency + 5XX,
both queue depths, DynamoDB consumed capacity against the free allowance.

**Why these four.** They answer the three real questions an operator has —
"is anything failing", "is anything stuck", "are users hurting" — with
thresholds tuned so a healthy demo never pages but the poison-message demo
fires within minutes. treat_missing_data=notBreaching keeps idle periods quiet.

**Test.**
```powershell
# fire the DLQ alarm live during your demo:
aws sqs send-message --queue-url <dlq-or-jobs-url> --message-body '{}'
# wait ~3 min (retry delays) -> DLQ count 1 -> email arrives
```
Open the dashboard link from `terraform output cloudwatch_dashboard_url`,
generate a roadmap live, and point at the moving invocation/error lines —
instant observability story.