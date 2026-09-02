###############################################################################
# phase5-dynamodb.tf
#
# Two tables replace localStorage AND Redis AND OpenSearch:
#
#   roadmaps  — source of truth for jobs + generated roadmaps
#       PK user_id (S) / SK sk (S)
#         SK "JOB#<uuid>"     -> generation job + status lifecycle
#         SK "ROADMAP#<uuid>" -> full roadmap document (days/tasks)
#   llm_cache — cache-aside store keyed by sha256(provider|model|prompt)
#       PK cache_key (S), TTL attribute expires_at auto-deletes stale rows
#
# Billing mode: PROVISIONED 2 RCU / 2 WCU sits comfortably inside DynamoDB's
# PERMANENT always-free allowance (25 GB storage + 25 RCU + 25 WCU). On-demand
# pricing is also free at tiny scale, but provisioned makes the "$0 bill"
# claim unambiguous. Point-in-time recovery is deliberately OFF (it bills).
###############################################################################

resource "aws_dynamodb_table" "roadmaps" {
  name           = "${var.project}-roadmaps"
  billing_mode   = "PROVISIONED"
  read_capacity  = 2
  write_capacity = 2

  hash_key  = "user_id"
  range_key = "sk"

  attribute {
    name = "user_id"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # Job records self-clean after 7 days; roadmaps never expire but omit the
  # attribute entirely so TTL ignores them.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  tags = { Name = "${var.project}-roadmaps", Replaces = "localStorage" }
}

resource "aws_dynamodb_table" "llm_cache" {
  name           = "${var.project}-llm-cache"
  billing_mode   = "PROVISIONED"
  read_capacity  = 2
  write_capacity = 2

  hash_key = "cache_key"

  attribute {
    name = "cache_key"
    type = "S"
  }

  # This IS the Redis replacement: entries expire themselves after
  # CACHE_TTL_SECONDS (default 24h) with zero cron/lambda cleanup cost.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  tags = { Name = "${var.project}-llm-cache", Replaces = "ElastiCache/Redis" }
}

# Phase 4: per-session focus logs. One row per completed work session with the
# measured focus score. Provisioned 2/2 (inside the permanent free tier).
# PK user_id / SK SESSION#<epoch-ms> -> a natural time-ordered query per user.
resource "aws_dynamodb_table" "focus_sessions" {
  name           = "${var.project}-focus-sessions"
  billing_mode   = "PROVISIONED"
  read_capacity  = 2
  write_capacity = 2

  hash_key  = "user_id"
  range_key = "sk"

  attribute {
    name = "user_id"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  tags = { Name = "${var.project}-focus-sessions", Phase = "4" }
}