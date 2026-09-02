###############################################################################
# phase4-async-generation.tf
#
# SQS + SNS decouple roadmap generation from the request/response cycle:
#
#   generate-roadmap (API)  --enqueue-->  SQS roadmap-jobs
#   SQS roadmap-jobs        --trigger-->  roadmap-worker Lambda
#   roadmap-worker          --publish-->  SNS events ("roadmap ready")
#
# Why this shape: LLM calls take 10-30s. Holding an HTTP connection open for
# that is fragile (browser timeouts, double-submits) and forces the API
# Lambda to stay warm doing nothing. A queue gives free retries, a DLQ for
# poison messages, and natural backpressure. The frontend polls the status
# endpoint instead of waiting on the socket.
###############################################################################

resource "aws_sqs_queue" "roadmap_jobs_dlq" {
  name                      = "${var.project}-roadmap-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days to inspect failures

  tags = { Name = "${var.project}-roadmap-jobs-dlq" }
}

resource "aws_sqs_queue" "roadmap_jobs" {
  name                       = "${var.project}-roadmap-jobs"
  visibility_timeout_seconds = 180    # > worker timeout (110) so retries never overlap
  message_retention_seconds  = 345600 # 4 days

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.roadmap_jobs_dlq.arn
    maxReceiveCount     = 3
  })

  tags = { Name = "${var.project}-roadmap-jobs" }
}

resource "aws_lambda_event_source_mapping" "worker_from_sqs" {
  function_name    = aws_lambda_function.fn["roadmap-worker"].arn
  event_source_arn = aws_sqs_queue.roadmap_jobs.arn
  enabled          = true

  batch_size             = 1 # one job at a time keeps failure isolation simple
  maximum_retry_attempts = 2

  # Worker returns { batchItemFailures } — only failed messages are retried.
  function_response_types = ["ReportBatchItemFailures"]
}

###############################################################################
# SNS: doubles as (a) "roadmap ready" domain events and (b) the alarm target
# for Phase 6. One topic, one email subscription.
###############################################################################

resource "aws_sns_topic" "events" {
  name = "${var.project}-events"

  tags = { Name = "${var.project}-events" }
}

resource "aws_sns_topic_subscription" "alert_email" {
  count = var.alert_email != "" ? 1 : 0

  topic_arn = aws_sns_topic.events.arn
  protocol  = "email"
  endpoint  = var.alert_email
}