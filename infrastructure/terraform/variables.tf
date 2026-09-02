###############################################################################
# variables.tf
###############################################################################

variable "aws_region" {
  description = "Region to deploy into. us-east-1 has every service used here."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "pomodoro-dashboard"
}

variable "demo_user_id" {
  description = <<-EOT
    Single-tenant user id used as the DynamoDB partition key. This demo has
    no auth (out of scope for an interview demo); clients may override it
    per-request with the x-user-id header.
  EOT
  type        = string
  default     = "demo-user"
}

variable "llm_provider" {
  description = "Default LLM provider: 'grok' (Groq) or 'gemini'. Stored in Parameter Store."
  type        = string
  default     = "grok"
  validation {
    condition     = contains(["grok", "gemini"], var.llm_provider)
    error_message = "llm_provider must be 'grok' or 'gemini'."
  }
}

variable "groq_api_key" {
  description = <<-EOT
    OPTIONAL. Groq API key — if set, Terraform stores it as a SecureString
    parameter. Trade-off: the value lands in terraform.tfstate. For real keys,
    leave this empty and run scripts/set-secrets.ps1 instead (recommended).
  EOT
  type        = string
  default     = ""
  sensitive   = true
}

variable "gemini_api_key" {
  description = "OPTIONAL. Gemini API key — same trade-off as groq_api_key."
  type        = string
  default     = ""
  sensitive   = true
}

variable "alert_email" {
  description = "Email subscribed to the SNS topic (alarms + roadmap-ready events). You must click the confirmation email. Empty = no subscription."
  type        = string
  default     = ""
}

variable "llm_cache_ttl_seconds" {
  description = "How long identical LLM responses stay cached in DynamoDB (the Redis replacement). Default 24h."
  type        = number
  default     = 86400
}