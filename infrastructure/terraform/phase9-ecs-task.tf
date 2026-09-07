###############################################################################
# phase9-ecs-task.tf — Phase 3 (Option B): Fargate task definition + service.
#
# 0.25 vCPU / 0.5 GB, desired_count from variable, on-demand FARGATE launch
# type, public IP (no NAT — see phase8-vpc.tf), container port 3000,
# container health check on /api/health, 7-day logs.
###############################################################################

# ---------------------------------------------------------------------------
# Task definition: the exact image already pushed to ECR (v1.0.0).
# HOSTNAME=0.0.0.0 is required — the standalone Next server binds to the
# task-private-IP only without it (proven bug from the audit).
# ---------------------------------------------------------------------------
resource "aws_ecs_task_definition" "app" {
  family                   = var.project
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256" # 0.25 vCPU
  memory                   = "512" # 0.5 GB
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "app"
      image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
      essential = true

      portMappings = [{ containerPort = 3000, protocol = "tcp" }]

      environment = [
        { name = "HOSTNAME", value = "0.0.0.0" },
        { name = "NODE_ENV", value = "production" },
        # Phase 5: cache endpoint (phase12-redis.tf). The app reads this when
        # enabling its cache path; local-mode behavior is unchanged without it.
        { name = "REDIS_URL", value = "redis://${aws_elasticache_cluster.main.cache_nodes[0].address}:6379" },
      ]

      healthCheck = {
        command     = ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.ecs_app.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "app"
        }
      }
    }
  ])
}

# ---------------------------------------------------------------------------
# Service: 1 task, on-demand FARGATE, public IP, fronted by the ALB
# (load_balancer block added in Phase 4 — see phase10-alb.tf). Circuit
# breaker prevents endless failed rollouts from churning billed tasks.
# ---------------------------------------------------------------------------
resource "aws_ecs_service" "app" {
  name            = "${var.project}-app"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true # the no-NAT cost design (see phase8-vpc.tf)
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn # phase10-alb.tf
    container_name   = "app"
    container_port   = 3000
  }

  health_check_grace_period_seconds = 30

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  enable_execute_command = true # ECS Exec replaces the missing ALB for debugging
}

output "ecs_cluster_name" {
  description = "ECS cluster running the app."
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "ECS service backing the app container."
  value       = aws_ecs_service.app.name
}

output "ecs_log_group" {
  description = "CloudWatch log group for the container."
  value       = aws_cloudwatch_log_group.ecs_app.name
}