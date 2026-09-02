# Interview Talking Points

## The one-paragraph answer (say this out loud)

> "I chose serverless over Fargate deliberately, as a cost-and-scale decision,
> not a constraint. This app's traffic is bursty and tiny — one user generates
> a roadmap, waits thirty seconds, then leaves. An always-on container behind
> an ALB bills for roughly 730 hours a month whether it serves ten requests or
> none; my Lambdas bill only for those requests and land inside the permanent
> free tier, so the demo costs literally zero to run. The same logic drove
> every substitution: OpenSearch's minimum cluster is real money every month
> to full-text-index maybe a hundred roadmaps, so I replaced relevance search
> with a DynamoDB Scan-plus-filter that is honest at this scale and has a clean
> upgrade path — add a GSI or swap the endpoint internals later without touching
> clients. ElastiCache bills hourly even idle, while identical LLM calls are a
> perfect cache pattern, so a TTL'd DynamoDB row gives me the same 24-hour
> response cache with zero standing infrastructure. And I kept SQS, SNS, S3,
> CloudWatch and least-privilege IAM exactly as asked, because they're free at
> this scale and they're where the architectural value actually lives: roadmap
> generation runs asynchronously through a queue with retries, a dead-letter
> queue and alarms, results commit atomically in a DynamoDB transaction, and
> the frontend polls a status endpoint instead of holding an HTTP connection
> open for a 20-second LLM call. So: same architecture diagram, same managed
> services story — sized to the workload instead of to a monthly bill."

## Anticipated follow-ups

**"Isn't Lambda cold start a problem?"**
Cold starts here are ~150-300ms (pure-JS, arm64, no VPC). Roadmap generation
itself takes 10-25s of LLM time — a 0.3s cold start is noise. I moved the slow
path off the request thread entirely via SQS, so no user ever waits on a cold
container.

**"DynamoDB Scan is O(n) — defend that."**
At demo scale n < 1,000 items and the filter projects summaries only, costing
fractions of one free RCU. I documented the upgrade ladder in code comments:
topic_lower GSI -> per-user partition queries -> actual OpenSearch if relevance
ranking is ever needed. Choosing Scan was a scoped decision, not ignorance.

**"How does your Redis replacement actually evict?"**
DynamoDB native TTL on `expires_at` (now + 24h). Deletion is asynchronous but
reads are conditional anyway (`GetItem` treats expired-but-not-collected rows
correctly because we check nothing — AWS guarantees expired items aren't
returned). Zero cron, zero Lambda janitor, zero dollars.

**"What happens when the LLM fails mid-generation?"**
The worker marks the job FAILED (so polling users get closure immediately),
rethrows, SQS retries up to 3 times with exponential backoff, then parks the
message in a DLQ. A CloudWatch alarm fires on DLQ depth > 0 and another on
sustained queue backlog. Recovery story: inspect DLQ, fix root cause, re-drive.

**"Where are your API keys?"**
SSM Parameter Store SecureStrings under /pomodoro/secrets/*, resolved at
runtime and cached per execution environment. Secrets Manager would cost
$0.40/secret/month forever after its trial — Parameter Store standard
parameters are always-free. Each function's IAM role can read ONLY that path;
the enqueue function doesn't even hold LLM keys since it never calls the LLM.

**"Why is CORS on the gateway and not in Lambda?"**
HTTP APIs inject Access-Control-* headers themselves; duplicating them inside
Lambda responses produces duplicate headers, which browsers reject. Subtle
detail worth mentioning — it shows you've debugged real CORS.

**"Least privilege — show me."**
One role per function, assembled from a capability matrix in locals.tf:
`roadmap-status` gets GetItem+Query on ONE table ARN; the presigner gets
PutObject on uploads/* ONLY; the worker additionally holds sqs_consume +
sns_publish + cache access. Every statement is scoped to this stack's ARNs,
and API invoke permissions are route-scoped (function X may only be called
via its exact METHOD/PATH ARN).

## Numbers worth memorizing
- 1M Lambda req/mo + 400,000 GB-seconds/mo — ALWAYS free (not trial)
- 1M API Gateway HTTP calls/mo — ALWAYS free
- DynamoDB: 25GB storage + 25 RCU/WCU provisioned — ALWAYS free (since 2014)
- ElastiCache smallest node ≈ $12/mo idle; OpenSearch minimum ≈ $175/mo
- Fargate 0.5 vCPU/1GB ≈ $8.60/mo + NLB ~$16/mo before any traffic