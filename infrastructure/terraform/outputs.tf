###############################################################################
# outputs.tf
###############################################################################

output "api_base_url" {
  description = "Set NEXT_PUBLIC_API_BASE_URL to this in the frontend."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "api_execution_arn" {
  value = aws_apigatewayv2_api.http.execution_arn
}

output "function_names" {
  description = "All deployed Lambda functions."
  value       = { for k, v in aws_lambda_function.fn : k => v.function_name }
}

output "dynamodb_tables" {
  value = {
    roadmaps  = aws_dynamodb_table.roadmaps.name
    llm_cache = aws_dynamodb_table.llm_cache.name
  }
}

output "sqs_queues" {
  value = {
    jobs = aws_sqs_queue.roadmap_jobs.url
    dlq  = aws_sqs_queue.roadmap_jobs_dlq.url
  }
}

output "resume_bucket" {
  value = aws_s3_bucket.resumes.id
}

output "sns_topic_arn" {
  value = aws_sns_topic.events.arn
}

output "cloudwatch_dashboard_url" {
  value = "https://console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "secrets_reminder" {
  description = "If you left the key variables empty, store keys before deploying."
  value       = <<-EOT
    Parameter Store paths expected by the Lambdas:
      ${local.ssm_config_path}/llm_provider   (String)     = ${var.llm_provider}
      ${local.ssm_secrets_path}/groq_api_key   (SecureString)
      ${local.ssm_secrets_path}/gemini_api_key (SecureString)
    Create with scripts/set-secrets.ps1 (or terraform vars groq_api_key/gemini_api_key).
  EOT
}