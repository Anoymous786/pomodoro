###############################################################################
# phase6-cloudwatch.tf
#
# Lambda logs are automatic (we set 7-day retention in phase1). What's added
# here is the OPERATING story: four alarms that answer "is the system
# healthy?"
#
#   1. worker errors        -> LLM/provider failures visible
#   2. main queue depth     -> jobs piling up (worker stuck/slow)
#   3. DLQ not empty        -> a poison message exhausted its retries
#   4. API Gateway 5XX      -> user-facing breakage
#
# All route to the same SNS topic as roadmap-ready events: one subscription,
# every signal. (Dashboard lives in phase6-dashboard.tf.)
###############################################################################

locals {
  alarm_actions = [aws_sns_topic.events.arn]
}

resource "aws_cloudwatch_metric_alarm" "worker_errors" {
  alarm_name          = "${var.project}-worker-errors"
  alarm_description   = "roadmap-worker threw errors (LLM or DynamoDB failures)."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  threshold           = 3
  treat_missing_data  = "notBreaching"

  metric_name = "Errors"
  namespace   = "AWS/Lambda"
  period      = 300
  statistic   = "Sum"

  dimensions = { FunctionName = aws_lambda_function.fn["roadmap-worker"].function_name }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions # email when it recovers too
}

resource "aws_cloudwatch_metric_alarm" "jobs_backlog" {
  alarm_name          = "${var.project}-jobs-backlog"
  alarm_description   = "Roadmap jobs are piling up in SQS — worker is slow, crashed, or throttled."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 3
  threshold           = 5
  treat_missing_data  = "notBreaching"

  metric_name = "ApproximateNumberOfMessagesVisible"
  namespace   = "AWS/SQS"
  period      = 300
  statistic   = "Maximum"

  dimensions = { QueueName = aws_sqs_queue.roadmap_jobs.name }

  alarm_actions = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.project}-dlq-has-messages"
  alarm_description   = "A poison message hit the DLQ after 3 failed attempts — needs manual inspection."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  treat_missing_data  = "notBreaching"

  metric_name = "ApproximateNumberOfMessagesVisible"
  namespace   = "AWS/SQS"
  period      = 300
  statistic   = "Maximum"

  dimensions = { QueueName = aws_sqs_queue.roadmap_jobs_dlq.name }

  alarm_actions = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.project}-api-5xx"
  alarm_description   = "API Gateway is returning server errors to clients."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  threshold           = 10
  treat_missing_data  = "notBreaching"

  metric_name = "5XXError"
  namespace   = "AWS/ApiGateway"
  period      = 300
  statistic   = "Sum"

  dimensions = { ApiId = aws_apigatewayv2_api.http.id }

  alarm_actions = local.alarm_actions
}