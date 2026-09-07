# ===========================================================================
# phase7-ecr.tf — Phase 2 (container migration, Option B): image registry.
#
# One private ECR repository for the app image built by ./Dockerfile.
# ECS/Fargate (a later phase) will pull from here. ECR has a 500 MB/month
# always-free allowance — the count-based lifecycle policy below keeps the
# stored footprint small (last 5 tagged + untagged expire in 1 day).
# ===========================================================================

resource "aws_ecr_repository" "app" {
  name = "pomodoro-dashboard-app"

  # Default AES256 encryption (AWS-owned key — free). No KMS key => no cost.
  image_tag_mutability = "MUTABLE"
  # Basic scanning is invoked manually only; automatic scan-on-push stays
  # off to keep the registry inside the free allowance.
  image_scanning_configuration {
    scan_on_push = false
  }
}

# Keep only a small number of recent images; clean up untagged quickly.
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep only the 5 most recent tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 5
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      }
    ]
  })
}

output "ecr_repository_uri" {
  description = "URI of the app image repository (use for ECS task definitions)."
  value       = aws_ecr_repository.app.repository_url
}