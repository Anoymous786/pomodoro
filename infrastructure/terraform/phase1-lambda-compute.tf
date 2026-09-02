###############################################################################
# phase1-lambda-compute.tf
#
# ONE for_each turns local.lambdas into: zip packages, per-function IAM
# roles (assembled from the capability matrix), log groups (7-day retention)
# and functions on Node.js 20 / arm64.
#
# Packaging notes:
#   * Each zip = the function's folder + ../lambda-src/shared + extra_dirs.
#     Shared modules are imported flat ("./aws.mjs"), so everything sits at
#     the zip root.
#   * Only resume-extractor has an npm dependency; run scripts/build-lambdas.ps1
#     once (`npm install` in its folder) before applying if you want PDF
#     extraction. Every other function needs zero installs.
###############################################################################

data "archive_file" "lambda" {
  for_each = local.lambdas

  type        = "zip"
  output_path = "${path.module}/build/${each.key}.zip"

  # The archive provider's nested `source` block accepts in-memory content
  # only (`content` + `filename`) — no directories. Every Lambda file here is
  # UTF-8 text, so we enumerate and inline them directly; no build/bundle step
  # exists in this stack. Files sit FLAT at the zip root, which is why
  # handlers import "./aws.mjs" rather than "../shared/aws.mjs".
  #
  # All functions are dependency-free ESM on the AWS SDK v3 bundled in the
  # nodejs20.x runtime.
  dynamic "source" {
    for_each = sort(concat(
      [for f in fileset("${path.module}/../lambda-src/functions/${each.key}", "**") :
        { content = file("${path.module}/../lambda-src/functions/${each.key}/${f}"), filename = f }
      ],
      [for f in local.shared_files :
        { content = file("${path.module}/../lambda-src/shared/${f}"), filename = f }
      ]
    ))

    content {
      content  = source.value.content
      filename = source.value.filename
    }
  }
}

resource "aws_iam_role" "lambda_exec" {
  for_each = local.lambdas

  name = "${var.project}-${each.key}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "${var.project}-${each.key}-role", Function = each.key }
}

resource "aws_iam_role_policy" "function_permissions" {
  for_each = local.lambdas

  name = "${var.project}-${each.key}-least-privilege"
  role = aws_iam_role.lambda_exec[each.key].id

  # Basic execution (CloudWatch Logs) + only this function's capabilities.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid      = "WriteOwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${aws_cloudwatch_log_group.fn[each.key].arn}:*"]
      }],
      flatten([for cap in each.value.caps : local.cap_policies[cap]])
    )
  })
}

# Explicit log groups so retention is 7 days instead of "forever"
# (free tier covers 5GB ingestion/month — a demo uses megabytes).
resource "aws_cloudwatch_log_group" "fn" {
  for_each = local.lambdas

  name              = "/aws/lambda/${var.project}-${each.key}"
  retention_in_days = 7

  tags = { Function = each.key }
}

resource "aws_lambda_function" "fn" {
  for_each = local.lambdas

  function_name = "${var.project}-${each.key}"
  description   = each.value.desc

  role          = aws_iam_role.lambda_exec[each.key].arn
  runtime       = "nodejs20.x"
  architectures = ["arm64"] # Graviton: ~20% cheaper, fully supported by pure-JS deps
  handler       = "index.handler"

  filename         = data.archive_file.lambda[each.key].output_path
  source_code_hash = data.archive_file.lambda[each.key].output_base64sha256

  timeout     = each.value.timeout
  memory_size = each.value.memory

  # Merge env vars from every capability this function holds.
  environment {
    variables = merge(
      { NODE_ENV = "production" },
      { DEMO_USER_ID = var.demo_user_id },
      merge([for cap in each.value.caps : local.env_per_cap[cap]]...)
    )
  }

  depends_on = [
    aws_iam_role_policy.function_permissions,
    aws_cloudwatch_log_group.fn, # ensures our group exists before first invoke
  ]

  tags = { Function = each.key }
}