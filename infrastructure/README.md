# Pomodoro Dashboard — AWS Always-Free Deployment

Serverless backend for the Pomodoro Roadmap Dashboard built exclusively from
services that are free FOREVER at this app's scale (not 12-month trials).
10 Lambda functions behind one HTTP API Gateway, DynamoDB for state +
cache + search + skill profiles, S3 for resume uploads, SQS+SNS for async generation,
CloudWatch alarms + dashboard for observability.

```
                         ┌──────────────────────────┐
  Browser (Next.js)      │  API Gateway HTTP API    │
  ─────────────────►     │  CORS • access logs •    │
   fetch(NEXT_PUBLIC_    │  9 routes                │
   API_BASE_URL + path)  └───────────┬──────────────┘
                                     │ AWS_PROXY (payload 2.0)
        ┌────────────┬───────────────┼────────────────┬─────────────┐
        ▼            ▼               ▼                ▼             ▼
  generate-roadmap intake/exams/  get-upload-url  roadmap-status  roadmap-search
        │         replan-day           │                            
        │ SQS            │ LLM     pre-signed PUT   GET job+doc   Scan/Query
        ▼                │(Groq/       │                             │
  ┌──────────┐           │ Gemini)     ▼                             │
  │SQS jobs  │           │        S3 resumes ◄──resume-extractor     │
  └────┬─────┘           │        (private)      (ObjectCreated)     │
       ▼                 │             │                             │
  roadmap-worker ────────┴──► DynamoDB roadmaps ◄────────────────────┘
  cache→LLM→txn-write          llm_cache (TTL=Redis)
       │
       ▼ SNS events ──► email (roadmap ready + ALARMS)
                        CloudWatch: 4 alarms + dashboard
```

## The substitution strategy

| Interviewer asked | We ship instead | Why it's the RIGHT call |
|---|---|---|
| ECS/Fargate + ALB | Lambda + HTTP API GW | Zero idle cost; 1M req/mo always free each; scale-to-zero matches a demo's bursty traffic |
| OpenSearch cluster | DynamoDB `Scan contains()` + `Query` | No cluster to feed/pay ($175+/mo min); substring search is honest at <1000 roadmaps; GSI upgrade path documented |
| ElastiCache (Redis) | `llm_cache` table w/ TTL attr | Redis bills ~$0.017/hr even idle (~$12/mo); TTL rows auto-expire identically at zero cost |
| S3 / SQS / SNS / IAM / CloudWatch | kept as asked | All genuinely always-free at this scale |

## Prerequisites
- Terraform >= 1.6 (`terraform version`)
- AWS CLI v2 configured (`aws sts get-caller-identity` works)
- Node 20+ only for the frontend dev server
- A Groq key (free) and/or Gemini key (free)

## Deploy (from `infrastructure/scripts`)

```powershell
# 1. LLM keys -> SSM SecureString (ALWAYS FREE; keeps secrets out of tfstate)
.\set-secrets.ps1 -GroqApiKey "gsk_..." [-GeminiApiKey "..."]

# 2. Provision everything (~40 resources, ~2 min)
cd ..\terraform
terraform init
terraform apply -var="alert_email=you@example.com"   # confirm the SNS email!

# 3. Point the frontend at the API
#    (copy the api_base_url output value)
Set-Content ..\..\.env.local "NEXT_PUBLIC_API_BASE_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com"
cd ..\..
npm run dev
```

Deploying phase-by-phase? Use `-target=` on a phase's anchor resource;
Terraform pulls its dependencies transitively:
`terraform apply -target=aws_lambda_function.fn["intake"]` etc.
(See PHASES-1-3.md / PHASES-4-6.md for the anchor of each phase.)

## Frontend behavior
No env var set -> identical local Next.js behavior (routes still work for dev).
Env var set -> async roadmap flow + S3 resume uploads activate automatically
(`lib/api.ts` is the single switch).

Hosting the frontend itself: Vercel Hobby or Netlify free tier are the
zero-ops choices; `npm run build && npm start` anywhere Node runs also works.

## Cost guarantee checklist
- DynamoDB: PROVISIONED 2 RCU/2 WCU x2 tables — inside the PERMANENT
  25/25 + 25GB allowance. PITR deliberately OFF (it bills).
- Lambda: arm64, well inside 1M requests + 400k GB-s/mo always-free.
- API Gateway HTTP: 1M calls/mo always-free.
- S3: <5GB, lifecycle expires objects after 30 days.
- SQS/SNS/CloudWatch: first million/free-tier thresholds never approached.
- Parameter Store standard parameters: unlimited free.

Expected invoice: **$0.00**, plus $0.02/mo of Route53/hosted-zone noise ONLY
if you register a domain (you don't need one).

## Teardown
```powershell
terraform destroy    # force_destroy=true empties the bucket; done.
aws ssm delete-parameter --name "/pomodoro/secrets/groq_api_key" # if you used set-secrets.ps1
```

## Troubleshooting
- **CORS errors**: check you're calling `https://...amazonaws.com` (https),
  and that the route exists (missing routes return 403 from the gateway).
- **"GROQ_API_KEY is not set"** in logs: run set-secrets.ps1, then redeploy
  functions (they cache parameters per execution environment).
- **Job stuck PROCESSING**: worker logs -> CloudWatch log group
  `/aws/lambda/pomodoro-dashboard-roadmap-worker`; DLQ alarm would fire.
- **PDF text empty**: scanned/image PDFs have no text layer — the extractor
  writes an explicit error JSON that surfaces in the UI.