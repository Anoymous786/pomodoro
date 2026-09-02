###############################################################################
# phase6-dashboard.tf — one CloudWatch dashboard for the live demo
###############################################################################

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.project}-overview"

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "text", x = 0, y = 0, width = 24, height = 2
        properties = {
          markdown = "# ${var.project} — always-free serverless stack\nLambda + API Gateway compute • DynamoDB state & cache • S3 resumes • SQS async jobs • SNS events"
        }
      },
      {
        type = "metric", x = 0, y = 2, width = 12, height = 6
        properties = {
          title  = "Lambda invocations (all functions)"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "Sum"
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", "${var.project}-generate-roadmap"],
            ["...", "${var.project}-intake"],
            ["...", "${var.project}-generate-exam"],
            ["...", "${var.project}-grade-exam"],
            ["...", "${var.project}-replan-day"],
            ["...", "${var.project}-roadmap-worker"]
          ]
        }
      },
      {
        type = "metric", x = 12, y = 2, width = 12, height = 6
        properties = {
          title  = "API Gateway latency & 5XX"
          region = var.aws_region
          view   = "timeSeries"
          metrics = [
            ["AWS/ApiGateway", "Latency", "ApiId", aws_apigatewayv2_api.http.id, { stat = "Average" }],
            ["...", { stat = "p99" }],
            ["AWS/ApiGateway", "5XXError", "ApiId", aws_apigatewayv2_api.http.id, { stat = "Sum", yAxis = "right" }]
          ]
        }
      },
      {
        type = "metric", x = 0, y = 8, width = 12, height = 6
        properties = {
          title  = "SQS job queue depth (backlog alarm >= 5)"
          region = var.aws_region
          view   = "timeSeries"
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.roadmap_jobs.name],
            ["...", aws_sqs_queue.roadmap_jobs_dlq.name]
          ]
        }
      },
      {
        type = "metric", x = 12, y = 8, width = 12, height = 6
        properties = {
          title  = "DynamoDB consumed capacity (free tier: 25 WCU / 25 RCU)"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "Sum"
          metrics = [
            ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", aws_dynamodb_table.roadmaps.name],
            ["...", aws_dynamodb_table.llm_cache.name],
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", aws_dynamodb_table.roadmaps.name],
            ["...", aws_dynamodb_table.llm_cache.name]
          ]
        }
      }
    ]
  })
}