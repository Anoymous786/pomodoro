###############################################################################
# phase10-alb.tf — Phase 4 (Option B): public ALB front door.
#
# Cost notes: ALB is the FIRST hourly-billed resource in this project
# (~$0.0225/hr + LCUs ≈ $18/mo). Everything here is the minimum viable
# footprint: one ALB, one target group, one HTTP listener (HTTPS/ACM is a
# later phase by design), no access logs (S3 + delivery cost avoided).
#
# Security model: the ALB SG accepts HTTP :80 from the world; the ECS task SG
# gains its FIRST (and only) ingress rule — :3000 from the ALB SG ONLY.
# The task remains unreachable from the internet directly.
###############################################################################

# ---------------------------------------------------------------------------
# ALB security group: public HTTP in, traffic to tasks on 3000 out.
# ---------------------------------------------------------------------------
resource "aws_security_group" "alb" {
  name        = "${var.project}-alb"
  description = "Public ALB: HTTP from internet, forward to ECS tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP from the internet"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description     = "Forward to ECS tasks on container port 3000 only"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }
}

# ---------------------------------------------------------------------------
# Task SG: add the single ingress rule. Port 3000 is reachable ONLY from the
# ALB SG — direct public access to the task stays impossible.
# (Egress 443 for ECR/logs/SSM/AWS APIs is unchanged in phase9-ecs.tf.)
# ---------------------------------------------------------------------------
resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.ecs_tasks.id
  description                  = "App port 3000 from the ALB only"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

# ---------------------------------------------------------------------------
# Target group: IP targets (awsvpc Fargate), port 3000, /api/health checks.
# Deregistration delay is trimmed so task recycling doesn't hold connections.
# ---------------------------------------------------------------------------
resource "aws_lb_target_group" "app" {
  name        = "${var.project}-app"
  target_type = "ip"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id

  health_check {
    enabled             = true
    path                = "/api/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 30
}

# ---------------------------------------------------------------------------
# Public ALB in the two existing public subnets. No HTTPS yet (Phase brief:
# HTTP listener is sufficient for first testing; ACM/domain come later).
# ---------------------------------------------------------------------------
resource "aws_lb" "app" {
  name               = "${var.project}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  # internal = false (default) — explicitly stated for readability.
  internal                   = false
  ip_address_type            = "ipv4"
  drop_invalid_header_fields = true
}

# HTTP :80 -> target group (testing listener; HTTPS added in a later phase).
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# ---------------------------------------------------------------------------
# NOTE: the ECS service is NOT redeclared here. The existing
# aws_ecs_service.app in phase9-ecs-task.tf gains a load_balancer block
# pointing at aws_lb_target_group.app (in-place update, no replacement).
# ---------------------------------------------------------------------------

output "alb_dns_name" {
  description = "Public DNS name of the ALB (app entry point for this phase)."
  value       = aws_lb.app.dns_name
}

output "alb_arn_suffix" {
  description = "ALB ARN suffix (for CloudWatch metric namespaces later)."
  value       = aws_lb.app.arn_suffix
}