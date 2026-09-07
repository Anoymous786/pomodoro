###############################################################################
# phase8-vpc.tf — Phase 3 (Option B): minimal cost-optimized network.
#
# DESIGN (agreed): NO NAT Gateway, NO private subnets, NO interface endpoints.
# Fargate tasks live in PUBLIC subnets with an auto-assigned public IP and
# reach ECR / CloudWatch Logs / SSM / DynamoDB over outbound HTTPS 443 via the
# Internet Gateway. Inbound is impossible (the task SG has zero ingress rules),
# and response egress is KB-sized. This avoids ~$32/mo (NAT) + ~$22/mo
# (interface endpoints) — the entire networking bill is $0.
###############################################################################

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

# Two public subnets in two AZs — Fargate places tasks here; subnet cost is $0.
resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.main.id
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  map_public_ip_on_launch = true
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

output "vpc_id" {
  description = "VPC the ECS tasks run in."
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "Subnets used by the Fargate tasks (public + auto public IP)."
  value       = aws_subnet.public[*].id
}