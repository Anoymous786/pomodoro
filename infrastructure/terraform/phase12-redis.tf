###############################################################################
# phase12-redis.tf — Phase 5 (Option B): cache layer.
#
# LOWEST-COST CONFIG: a single Valkey cache.t4g.micro node (~$12/mo).
# ElastiCache Serverless was rejected — its per-GB-hour + request billing
# floor is higher for always-on demo traffic. Valkey (Redis-compatible, OSS)
# keeps the same ioredis/resp client path without licensing concerns.
#
# PRIVACY: ElastiCache nodes never get public IPs; the cluster SG accepts
# 6379 ONLY from the ECS task SG, and the task SG gains a matching egress
# rule. Nothing else in the VPC (or internet) can reach it.
###############################################################################

# Redis SG: ingress 6379 from ECS tasks only; no other rules.
resource "aws_security_group" "redis" {
  name        = "${var.project}-redis"
  description = "Valkey cache: port 6379 from ECS tasks only"
  vpc_id      = aws_vpc.main.id

  egress {
    description     = "Node responses to task connections only"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_tasks" {
  security_group_id            = aws_security_group.redis.id
  description                  = "Redis 6379 from ECS tasks only"
  referenced_security_group_id = aws_security_group.ecs_tasks.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

# Task SG currently egresses 443 only — add the matching 6379 egress.
resource "aws_vpc_security_group_egress_rule" "tasks_to_redis" {
  security_group_id            = aws_security_group.ecs_tasks.id
  description                  = "Redis 6379 to the cache SG only"
  referenced_security_group_id = aws_security_group.redis.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

# The existing two public subnets double as the cache subnets (nodes are
# private-IP-only regardless of subnet publicity; SGs enforce isolation).
resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.project}-cache"
  subnet_ids = aws_subnet.public[*].id
}

resource "aws_elasticache_cluster" "main" {
  cluster_id = "${var.project}-cache"
  # NOTE: the single-node CreateCacheCluster API rejects engine "valkey"
  # ("Please use CreateReplicationGroup for Valkey") — so this is Redis OSS,
  # same price on t4g.micro and the same wire protocol.
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.t4g.micro"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]

  # Cost/ops trim: no snapshots, no maintenance-window surprises beyond the
  # default, no automatic minor upgrades mid-demo.
  snapshot_retention_limit   = 0
  auto_minor_version_upgrade = false

  # Logging to CloudWatch would add a log group + delivery — omitted for cost.
  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.slowlog.name
    destination_type = "cloudwatch-logs"
    log_format       = "text"
    log_type         = "slow-log"
  }
}

# Slow-log only (tiny volume) so cache problems stay observable; engine log
# is the expensive one and stays off.
resource "aws_cloudwatch_log_group" "slowlog" {
  name              = "/pomodoro/elasticache/slowlog"
  retention_in_days = 7
}

output "redis_endpoint" {
  description = "Primary Valkey endpoint (host:6379) wired into the ECS task."
  value       = "${aws_elasticache_cluster.main.cache_nodes[0].address}:6379"
}