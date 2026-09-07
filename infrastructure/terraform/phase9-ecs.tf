###############################################################################
# phase9-ecs.tf — Phase 3 (Option B): cluster + security group + IAM roles.
# (Task definition and service live in phase9-ecs-task.tf.)
#
# Smallest viable footprint: egress-443-only SG, Container Insights OFF,
# 7-day log retention. ECS Exec is enabled so the task can be inspected
# WITHOUT any ALB/ingress.
###############################################################################

# ---------------------------------------------------------------------------
# Task security group: ZERO ingress rules. Nothing can connect to the task
# from anywhere except the ALB (standalone rule in phase10-alb.tf). All rules
# are standalone aws_vpc_security_group_*_rule resources — inline blocks on
# this SG would reconcile/revoke the standalone rules (this exact drift broke
# the Redis path in the Phase 5 verification).
# ---------------------------------------------------------------------------
resource "aws_security_group" "ecs_tasks" {
  name        = "${var.project}-ecs-tasks"
  description = "ECS Fargate tasks: outbound HTTPS only, no ingress"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_egress_rule" "tasks_to_https" {
  security_group_id = aws_security_group.ecs_tasks.id
  description       = "HTTPS to AWS service endpoints (ECR, logs, SSM, DynamoDB, S3, SQS, SNS)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_ecs_cluster" "main" {
  name = "${var.project}-cluster"

  # Container Insights bills per-metric — deliberately OFF for cost.
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_cloudwatch_log_group" "ecs_app" {
  name              = "/pomodoro/ecs/app"
  retention_in_days = 7
}

# ---------------------------------------------------------------------------
# Execution role: lets ECS itself pull the image from ECR, write logs, and
# resolve the SSM SecureStrings referenced by the task definition.
# ---------------------------------------------------------------------------
resource "aws_iam_role" "ecs_execution" {
  name = "${var.project}-ecs-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_ssm" {
  name = "ssm-secrets-read"
  role = aws_iam_role.ecs_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameters", "ssm:GetParameter"]
      Resource = ["arn:aws:ssm:${var.aws_region}::parameter${local.ssm_secrets_path}/*"]
    }]
  })
}

# ---------------------------------------------------------------------------
# Task role: what the CONTAINER may do. Least-privilege mirror of the Lambda
# capability set (same tables/bucket/queue/topic), plus the SSM message
# channels required by ECS Exec (our ingress-free debugging path). The
# container currently runs in local mode; these grants are for its AWS mode
# and are scoped exactly like the Lambda policies.
# ---------------------------------------------------------------------------
resource "aws_iam_role" "ecs_task" {
  name = "${var.project}-ecs-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task_caps" {
  name = "app-capabilities"
  role = aws_iam_role.ecs_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SsmParametersRead"
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = [
          "arn:aws:ssm:${var.aws_region}::parameter${local.ssm_secrets_path}/*",
          aws_ssm_parameter.llm_provider.arn,
        ]
      },
      {
        Sid      = "EcsExec"
        Effect   = "Allow"
        Action   = ["ssmmessages:CreateControlChannel", "ssmmessages:OpenControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenDataChannel"]
        Resource = ["*"]
      },
      {
        Sid    = "DynamoDbData"
        Effect = "Allow"
        Action = ["dynamodb:Query", "dynamodb:Scan", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:UpdateItem"]
        Resource = [
          aws_dynamodb_table.roadmaps.arn,
          aws_dynamodb_table.llm_cache.arn,
          aws_dynamodb_table.focus_sessions.arn,
        ]
      },
      {
        Sid      = "S3Resumes"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = ["${aws_s3_bucket.resumes.arn}/*"]
      },
      {
        Sid      = "SqsJobsSend"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [aws_sqs_queue.roadmap_jobs.arn]
      },
      {
        Sid      = "SnsEventsPublish"
        Effect   = "Allow"
        Action   = ["sns:Publish"]
        Resource = [aws_sns_topic.events.arn]
      },
    ]
  })
}