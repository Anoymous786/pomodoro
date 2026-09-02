###############################################################################
# phase2-api-gateway.tf
#
# One HTTP API (API Gateway v2) fronts every endpoint. HTTP APIs are the
# right fit here: ~70% cheaper than REST APIs (and free at 1M req/mo),
# lower latency, native JWT support if auth is ever added.
#
# CORS is configured ON THE GATEWAY, not in Lambda responses — API Gateway
# injects the headers on preflight AND actual responses; duplicating them
# inside Lambda would produce duplicate headers and break browsers.
#
# Route paths intentionally mirror the old Next.js routes so the frontend
# swap is purely a base-URL change.
###############################################################################

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${var.project}-http-api"
  retention_in_days = 7
}

resource "aws_apigatewayv2_api" "http" {
  name          = "${var.project}-http-api"
  protocol_type = "HTTP"
  description   = "Pomodoro Dashboard API (Lambda proxy backend)"

  cors_configuration {
    allow_origins = ["*"] # tighten to the frontend origin before any real use
    allow_methods = ["GET", "PUT", "POST", "OPTIONS"]
    allow_headers = ["content-type", "x-user-id"]
    max_age       = 86400
  }

  tags = { Name = "${var.project}-http-api" }
}

# $default stage auto-deploys route changes and ships access logs to CW.
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      ip               = "$context.identity.sourceIp"
      requestTime      = "$context.requestTime"
      httpMethod       = "$context.httpMethod"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      protocol         = "$context.protocol"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integration.error"
      latency          = "$context.responseLatency"
    })
  }

  tags = { Name = "${var.project}-default-stage" }
}

###############################################################################
# Integrations + routes (Lambda proxy, payload format 2.0)
###############################################################################

locals {
  routes = {
    "POST /api/generate-roadmap"      = { fn = "generate-roadmap" }
    "GET /api/roadmap-status/{jobId}" = { fn = "roadmap-status" }
    "GET /api/search"                 = { fn = "roadmap-search" }
    "POST /api/intake"                = { fn = "intake" }
    "POST /api/generate-exam"         = { fn = "generate-exam" }
    "POST /api/grade-exam"            = { fn = "grade-exam" }
    "POST /api/replan-day"            = { fn = "replan-day" }
    "POST /api/focus-logs"            = { fn = "focus-logs" }
    "GET /api/progress"               = { fn = "progress" }
    "PUT /api/progress"               = { fn = "progress" } # one fn, two routes
    "POST /api/uploads/presign"       = { fn = "get-upload-url" }
    "GET /api/uploads/text"           = { fn = "get-upload-url" } # one fn, two routes
  }

  # One integration per DISTINCT function (routes may share one).
  route_fns = distinct([for r in local.routes : r.fn])
}

resource "aws_apigatewayv2_integration" "lambda_proxy" {
  for_each = toset(local.route_fns)

  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.fn[each.value].invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000 # hard cap for synchronous LLM endpoints
}

resource "aws_apigatewayv2_route" "routes" {
  for_each = local.routes

  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.lambda_proxy[each.value.fn].id}"
}

# Route-scoped invoke permissions: each Lambda may only be invoked through
# ITS OWN route ARN (least privilege down to path+method).
resource "aws_lambda_permission" "from_api" {
  for_each = local.routes

  function_name = aws_lambda_function.fn[each.value.fn].function_name
  action        = "lambda:InvokeFunction"
  principal     = "apigateway.amazonaws.com"
  # Route-key ARNs contain no space: "POST /path" -> "POST/path".
  source_arn = "${aws_apigatewayv2_api.http.execution_arn}/*/${replace(each.key, " ", "")}"
}