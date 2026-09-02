# Phases 1–3 — What was built, why, and what to test

Each phase lists: **Built** (plain English) • **Why this service** •
**Test before moving on**. Phase anchors for incremental deploys:
`terraform apply -target=<anchor>` pulls dependencies automatically.

---

## Phase 1 — API routes -> Lambda functions
**Anchor:** `aws_lambda_function.fn["intake"]`

**Built.** Every Next.js route handler became a standalone Node 20 Lambda:
`generate-roadmap`, `intake`, `generate-exam`, `grade-exam`, `replan-day`.
The validation rules, prompts, provider dispatch and response shapes were
ported line-for-line from `app/api/*` + `lib/llm.ts` — including the graceful
behaviors users already had (grading never blocks the UI; a bad intake parse
ends the flow instead of erroring). All functions are dependency-free ESM;
the AWS SDK v3 bundled in the runtime does everything else. Secrets resolve at
runtime from Parameter Store SecureStrings under `/pomodoro/secrets/*`
(created via `scripts/set-secrets.ps1`) with an env-var override for local
tests. Packaging is one zip per function assembled by Terraform itself — no
build step, no bundler.

**Why Lambdas.** The workload is bursty single-user traffic with multi-second
LLM waits. Containers bill ~730 hrs/mo to serve maybe fifty requests; Lambda's
1M requests + 400k GB-s monthly allowance covers it forever at $0, scales
concurrently per request (no queue-of-requests behind one container), and the
per-function split gives blast-radius isolation plus per-route IAM.

**Test.**
```powershell
cd infrastructure\terraform   # after apply
$env:AWS_PAGER=""
aws lambda invoke --function-name pomodoro-dashboard-intake `
  --cli-binary-format raw-in-base64-out `
  --payload file://..\test-payloads\intake.json ..\test-out\intake.json
Get-Content ..\test-out\intake.json     # expect {"decision":{"next_question":...}}
# repeat with generate-exam / replan-day payloads; grade-exam returns {score,message}
```
Also verify least privilege in console IAM: intake's role has ONLY
ssm:GetParameter on /pomodoro/* (+ KMS condition), nothing else.

---

## Phase 2 — HTTP API Gateway
**Anchor:** `aws_apigatewayv2_api.http`

**Built.** One HTTP API fronts nine routes mirroring the old paths exactly
(`/api/intake`, `/api/generate-exam`, `/api/grade-exam`, `/api/replan-day`,
plus new ones for later phases). Payload-format-2.0 proxy integrations,
CORS configured ON THE GATEWAY (Lambda responses intentionally carry no CORS
headers — duplicates break browsers), `$default` stage with auto-deploy and
JSON access logs into a 7-day-retention CloudWatch log group, and route-scoped
lambda permissions (each function may be invoked only through its own
METHOD+PATH ARN).

**Why HTTP API (v2).** Same always-free million calls as REST APIs but ~70%
cheaper beyond that, lower latency, simpler auth story later (JWT authorizers
are native). Access logging satisfies "prove what happened" in demos.

**Test.**
```powershell
$api = terraform output -raw api_base_url
curl.exe -s -X POST "$api/api/intake" -H "content-type: application/json" `
  -d '{\"topic\":\"docker\"}'
curl.exe -s -i -X OPTIONS "$api/api/intake"    # expect access-control-* headers
```
Check log group `/aws/apigateway/pomodoro-dashboard-http-api` shows JSON lines
with routeKey/status/latency.

---

## Phase 3 — S3 resume uploads
**Anchor:** `aws_s3_bucket.resumes`

**Built.** A private bucket (all four public-access blocks on, SSE-S3,
30-day lifecycle, force_destroy for clean teardown). `POST /api/uploads/presign`
returns a 15-minute pre-signed PUT scoped to `uploads/<uuid>/<filename>` with a
server-decided Content-Type (the signature depends on it). The browser uploads
DIRECTLY to S3 — file bytes never transit API Gateway or any Lambda. An
`ObjectCreated` notification (one filter per extension) invokes
`resume-extractor`, which extracts text — .txt/.md/.csv natively, .pdf via a
zlib stream decoder, .docx via a ~40-line built-in ZIP/XML reader — and writes
`extracted/<key>.json`. The frontend (`uploadResumeToS3` in lib/api.ts) polls
`GET /api/uploads/text?key=...` until text appears. Failures write an explicit
error JSON so the UI gets closure instead of spinning.

**Why S3 presigned URLs.** Direct-to-S3 is the canonical pattern: bypasses
API Gateway's 10MB payload cap, costs zero compute for transfer, keeps the
bucket private while letting unauthenticated browsers write exactly one object
to exactly one key for exactly 15 minutes. The extractor-as-Lambda keeps the
pipeline event-driven — no polling worker ever runs unless a file lands.

**Test.**
```powershell
$body = '{"filename":"resume.txt"}'
$r = curl.exe -s -X POST "$api/api/uploads/presign" -H "content-type: application/json" -d $body | ConvertFrom-Json
Set-Content $env:TEMP\resume.txt "Senior engineer, five years of AWS experience."
curl.exe -s -X PUT $r.uploadUrl -H "content-type: $($r.contentType)" --data-binary "@$env:TEMP\resume.txt"
Start-Sleep 3; curl.exe -s "$($r.pollTextUrl -replace '^\$', $api)"  # prepend base URL if relative
Get-ChildItem s3://  # aws s3 ls s3://pomodoro-dashboard-resumes-<acct>/extracted/ shows the JSON
```
Then in the UI: set NEXT_PUBLIC_API_BASE_URL, restart dev server, attach a
resume in the intake flow — it uploads to S3 and infers level server-side.
Verify the bucket rejects anonymous GET (`aws s3 cp s3://... -` without creds
fails with 403).