###############################################################################
# phase0-foundations.tf
#
# Cross-cutting primitives that later phases reference:
#   * identity data sources (for ARN construction)
#   * Parameter Store namespace for config + LLM API keys (ALWAYS FREE)
#
# Why Parameter Store instead of Secrets Manager?
#   Secrets Manager costs $0.40 per secret per month AFTER a 30-day trial.
#   Standard SSM Parameters (including SecureString, which encrypts with the
#   AWS-managed aws/ssm KMS key) are free forever at any plausible count.
#   For an interview demo that must produce a $0 bill, it is the correct tool.
###############################################################################

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_region" "current" {}

locals {
  account_id  = data.aws_caller_identity.current.account_id
  partition   = data.aws_partition.current.partition
  region_name = data.aws_region.current.name

  ssm_config_path  = "/pomodoro/config"
  ssm_secrets_path = "/pomodoro/secrets"
}

# Non-secret runtime configuration (plain String parameter).
resource "aws_ssm_parameter" "llm_provider" {
  name        = "${local.ssm_config_path}/llm_provider"
  description = "Active LLM provider: grok | gemini"
  type        = "String"
  value       = var.llm_provider

  tags = { Name = "${var.project}-llm-provider" }
}

# Optional TF-managed key params (only created when the variable is non-empty).
# Recommended path is scripts/set-secrets.ps1 so keys never touch tfstate.
resource "aws_ssm_parameter" "groq_api_key" {
  count = var.groq_api_key != "" ? 1 : 0

  name        = "${local.ssm_secrets_path}/groq_api_key"
  description = "Groq API key (SecureString, encrypted with aws/ssm KMS key)"
  type        = "SecureString"
  value       = var.groq_api_key

  tags = { Name = "${var.project}-groq-key" }

  lifecycle {
    ignore_changes = [value] # rotate via set-secrets.ps1, not terraform apply
  }
}

resource "aws_ssm_parameter" "gemini_api_key" {
  count = var.gemini_api_key != "" ? 1 : 0

  name        = "${local.ssm_secrets_path}/gemini_api_key"
  description = "Gemini API key (SecureString, encrypted with aws/ssm KMS key)"
  type        = "SecureString"
  value       = var.gemini_api_key

  tags = { Name = "${var.project}-gemini-key" }

  lifecycle {
    ignore_changes = [value]
  }
}