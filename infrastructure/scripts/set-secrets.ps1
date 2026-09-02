#Requires -Version 5.1
<#
.SYNOPSIS
  Stores LLM API keys in SSM Parameter Store (SecureString — ALWAYS FREE).
  Preferred over typing keys into terraform variables (which would persist
  them into terraform.tfstate).

.USAGE
  .\set-secrets.ps1 -GroqApiKey "gsk_..."
  .\set-secrets.ps1 -GroqApiKey "gsk_..." -GeminiApiKey "AIza..." -Region us-east-1

.NOTES
  Requires AWS CLI v2 configured with credentials that allow ssm:PutParameter.
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$GroqApiKey,

  [string]$GeminiApiKey = "",

  [string]$Region = "us-east-1"
)

$ErrorActionPreference = "Stop"

Write-Host "Storing /pomodoro/secrets/groq_api_key (SecureString)..."
aws ssm put-parameter `
  --name "/pomodoro/secrets/groq_api_key" `
  --type "SecureString" `
  --value $GroqApiKey `
  --region $Region `
  --overwrite | Out-Null
Write-Host "  done."

if ($GeminiApiKey -ne "") {
  Write-Host "Storing /pomodoro/secrets/gemini_api_key (SecureString)..."
  aws ssm put-parameter `
    --name "/pomodoro/secrets/gemini_api_key" `
    --type "SecureString" `
    --value $GeminiApiKey `
    --region $Region `
    --overwrite | Out-Null
  Write-Host "  done."
}

Write-Host ""
Write-Host "Keys stored. Lambdas resolve them at runtime via ssm:GetParameter"
Write-Host "(least-privilege scoped to /pomodoro/* only)."