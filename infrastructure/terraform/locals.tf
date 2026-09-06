###############################################################################
# locals.tf — function map + capability->env mapping
#
# Every Lambda is described ONCE here (timeout, memory, IAM capabilities).
# phase1-lambda-compute.tf turns this map into roles, log groups, deployment
# packages and functions with a single for_each.
###############################################################################

locals {
  # Shared modules zipped into every function (flat at the zip root).
  shared_files = fileset("${path.module}/../lambda-src/shared", "**")

  # Capability -> environment variables. A function only learns the IDs of
  # resources it is allowed to touch (least knowledge + least privilege).
  env_per_cap = {
    llm_keys           = { LLM_PROVIDER_PARAM = aws_ssm_parameter.llm_provider.name, GROQ_API_KEY_PARAM = "${local.ssm_secrets_path}/groq_api_key", GEMINI_API_KEY_PARAM = "${local.ssm_secrets_path}/gemini_api_key" }
    ddb_roadmaps_rw    = { ROADMAPS_TABLE = aws_dynamodb_table.roadmaps.name }
    ddb_roadmaps_ro    = { ROADMAPS_TABLE = aws_dynamodb_table.roadmaps.name }
    ddb_skills_rw      = { ROADMAPS_TABLE = aws_dynamodb_table.roadmaps.name }
    ddb_search         = { ROADMAPS_TABLE = aws_dynamodb_table.roadmaps.name }
    ddb_cache_rw       = { CACHE_TABLE = aws_dynamodb_table.llm_cache.name, CACHE_TTL_SECONDS = tostring(var.llm_cache_ttl_seconds) }
    sqs_send           = { JOBS_QUEUE_URL = aws_sqs_queue.roadmap_jobs.url }
    sqs_consume        = { JOBS_QUEUE_URL = aws_sqs_queue.roadmap_jobs.url }
    sns_publish        = { EVENTS_TOPIC_ARN = aws_sns_topic.events.arn }
    s3_presign         = { RESUME_BUCKET = aws_s3_bucket.resumes.bucket }
    s3_extracted_read  = { RESUME_BUCKET = aws_s3_bucket.resumes.bucket }
    s3_uploads_read    = { RESUME_BUCKET = aws_s3_bucket.resumes.bucket }
    s3_extracted_write = { RESUME_BUCKET = aws_s3_bucket.resumes.bucket }
    ddb_focus_rw       = { FOCUS_TABLE = aws_dynamodb_table.focus_sessions.name }
  }

  # The functions themselves — every one is dependency-free ESM running on
  # the AWS SDK v3 bundled in the nodejs20.x runtime (zero npm installs).
  lambdas = {
    # ---- Phase 1/4: migrated Next.js routes -------------------------------
    "generate-roadmap" = {
      desc    = "POST /api/generate-roadmap — validates input, stores a PENDING job in DynamoDB, enqueues to SQS (async; needs no LLM keys)"
      caps    = ["ddb_roadmaps_rw", "sqs_send"]
      timeout = 15
      memory  = 256
    }
    "intake" = {
      desc    = "POST /api/intake — adaptive intake conversation (LLM call, synchronous)"
      caps    = ["llm_keys"]
      timeout = 29 # stay under API Gateway's 30s integration timeout
      memory  = 256
    }
    "generate-exam" = {
      desc    = "POST /api/generate-exam — per-task quiz generation (LLM call)"
      caps    = ["llm_keys"]
      timeout = 29
      memory  = 256
    }
    "grade-exam" = {
      desc    = "POST /api/grade-exam — grades an attempt (LLM call, graceful fallback preserved)"
      caps    = ["llm_keys"]
      timeout = 29
      memory  = 256
    }
    "replan-day" = {
      desc    = "POST /api/replan-day — re-fits a day's tasks into a time budget (LLM call)"
      caps    = ["llm_keys"]
      timeout = 29
      memory  = 256
    }

    # ---- Phase 4: focus session logging --------------------------------
    "focus-logs" = {
      desc    = "POST /api/focus-logs — persists a client-measured focus score for one work session"
      caps    = ["ddb_focus_rw"]
      timeout = 12
      memory  = 256
    }

    # ---- Phase 4: async worker + polling ----------------------------------
    "roadmap-worker" = {
      desc    = "SQS-triggered: cache check -> LLM -> DynamoDB (transactional) -> SNS 'ready' event"
      caps    = ["llm_keys", "ddb_roadmaps_rw", "ddb_cache_rw", "sqs_consume", "sns_publish"]
      timeout = 110 # must stay below the queue visibility timeout (180)
      memory  = 512
    }
    "roadmap-status" = {
      desc    = "GET /api/roadmap-status/{jobId} — frontend polls this while the worker runs"
      caps    = ["ddb_roadmaps_ro"]
      timeout = 12
      memory  = 256
    }

    # ---- Phase 5: search ---------------------------------------------------
    "roadmap-search" = {
      desc    = "GET /api/search?topic=... — Scan+Filter over roadmaps (OpenSearch substitute at demo scale)"
      caps    = ["ddb_search"]
      timeout = 12
      memory  = 256
    }

    # ---- Phase 2 (durable progress): PROGRESS# docs -------------------
    "progress" = {
      desc    = "GET/PUT /api/progress — durable per-task progress docs (conditional rev-guarded writes)"
      caps    = ["ddb_roadmaps_rw"]
      timeout = 12
      memory  = 256
    }

    # ---- §13: durable per-topic skill profiles (SKILL# items) ---------------
    "skill-profile" = {
      desc    = "GET/POST /api/skill-profile — validated per-topic skill profile storage in the roadmaps table (SKILL# items)"
      caps    = ["ddb_skills_rw"]
      timeout = 12
      memory  = 256
    }

    # ---- Phase 3: resume uploads -------------------------------------------
    "get-upload-url" = {
      desc    = "POST /api/uploads/presign + GET /api/uploads/text — pre-signed PUTs and extracted-text reads"
      caps    = ["s3_presign", "s3_extracted_read"]
      timeout = 12
      memory  = 256
    }
    "resume-extractor" = {
      desc    = "S3 ObjectCreated trigger — extracts text from .txt/.md/.csv/.pdf/.docx uploads"
      caps    = ["s3_uploads_read", "s3_extracted_write"]
      timeout = 90
      memory  = 512
    }
  }
}