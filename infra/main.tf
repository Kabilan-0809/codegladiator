terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket = "codegladiator-tfstate"
    key    = "infra/terraform.tfstate"
    region = "us-east-1"
  }
}

provider "aws" {
  region = var.aws_region
}

# ─── Variables ────────────────────────────────────────────────

variable "aws_region" {
  default = "us-east-1"
}

variable "environment" {
  default = "dev"
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "jwt_secret" {
  type      = string
  sensitive = true
}

variable "anthropic_api_key" {
  type      = string
  sensitive = true
}

# ─── VPC ──────────────────────────────────────────────────────

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# ─── EKS Cluster ──────────────────────────────────────────────

resource "aws_iam_role" "eks_cluster" {
  name = "codegladiator-eks-cluster-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_cluster_policy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
  role       = aws_iam_role.eks_cluster.name
}

resource "aws_eks_cluster" "main" {
  name     = "codegladiator-${var.environment}"
  role_arn = aws_iam_role.eks_cluster.arn

  vpc_config {
    subnet_ids = data.aws_subnets.default.ids
  }

  depends_on = [aws_iam_role_policy_attachment.eks_cluster_policy]
}

resource "aws_iam_role" "eks_nodes" {
  name = "codegladiator-eks-nodes-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_worker_node" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
  role       = aws_iam_role.eks_nodes.name
}

resource "aws_iam_role_policy_attachment" "eks_cni" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
  role       = aws_iam_role.eks_nodes.name
}

resource "aws_iam_role_policy_attachment" "ecr_readonly" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
  role       = aws_iam_role.eks_nodes.name
}

resource "aws_eks_node_group" "main" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "codegladiator-nodes-${var.environment}"
  node_role_arn   = aws_iam_role.eks_nodes.arn
  subnet_ids      = data.aws_subnets.default.ids
  instance_types  = ["t3.medium"]

  scaling_config {
    desired_size = 2
    max_size     = 5
    min_size     = 2
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_worker_node,
    aws_iam_role_policy_attachment.eks_cni,
    aws_iam_role_policy_attachment.ecr_readonly,
  ]
}

# ─── RDS PostgreSQL ───────────────────────────────────────────

resource "aws_db_instance" "postgres" {
  identifier           = "codegladiator-db-${var.environment}"
  engine               = "postgres"
  engine_version       = "16"
  instance_class       = "db.t3.micro"
  allocated_storage    = 20
  storage_encrypted    = true
  db_name              = "gladiator"
  username             = "postgres"
  password             = var.db_password
  multi_az             = false
  skip_final_snapshot  = true
  publicly_accessible  = false

  tags = {
    Environment = var.environment
    Project     = "codegladiator"
  }
}

# ─── ElastiCache Redis ────────────────────────────────────────

resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "codegladiator-redis-${var.environment}"
  engine               = "redis"
  engine_version       = "7.0"
  node_type            = "cache.t3.micro"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379

  tags = {
    Environment = var.environment
    Project     = "codegladiator"
  }
}

# ─── SQS Queues ───────────────────────────────────────────────

resource "aws_sqs_queue" "execution_dlq" {
  name                      = "codegladiator-execution-dlq-${var.environment}"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "execution_queue" {
  name                       = "codegladiator-execution-queue-${var.environment}"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 345600

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.execution_dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_sqs_queue" "match_dlq" {
  name                      = "codegladiator-match-dlq-${var.environment}"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "match_queue" {
  name                       = "codegladiator-match-queue-${var.environment}"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 345600

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.match_dlq.arn
    maxReceiveCount     = 3
  })
}

# ─── S3 Bucket ────────────────────────────────────────────────

resource "aws_s3_bucket" "submissions" {
  bucket = "codegladiator-submissions-${var.environment}"

  tags = {
    Environment = var.environment
    Project     = "codegladiator"
  }
}

resource "aws_s3_bucket_versioning" "submissions" {
  bucket = aws_s3_bucket.submissions.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "submissions" {
  bucket = aws_s3_bucket.submissions.id

  rule {
    id     = "expire-old-submissions"
    status = "Enabled"

    expiration {
      days = 90
    }
  }
}

# ─── Lambda — Ladder Scheduler ────────────────────────────────

resource "aws_iam_role" "lambda_role" {
  name = "codegladiator-lambda-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "lambda_policy" {
  name = "codegladiator-lambda-access-${var.environment}"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["sqs:*"]
        Resource = [
          aws_sqs_queue.execution_queue.arn,
          aws_sqs_queue.match_queue.arn,
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.submissions.arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.app_secrets.arn
      }
    ]
  })
}

resource "aws_lambda_function" "ladder_scheduler" {
  function_name = "codegladiator-ladder-scheduler-${var.environment}"
  role          = aws_iam_role.lambda_role.arn
  handler       = "dist/index.handler"
  runtime       = "nodejs20.x"
  timeout       = 300
  memory_size   = 512

  filename = "lambda-placeholder.zip"

  environment {
    variables = {
      ENVIRONMENT = var.environment
    }
  }
}

# ─── CloudWatch Event Rules ──────────────────────────────────

resource "aws_cloudwatch_event_rule" "bracket_init" {
  name                = "codegladiator-bracket-init-${var.environment}"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "bracket_init" {
  rule      = aws_cloudwatch_event_rule.bracket_init.name
  target_id = "ladder-scheduler-bracket-init"
  arn       = aws_lambda_function.ladder_scheduler.arn
  input     = jsonencode({ trigger = "BRACKET_INIT" })
}

resource "aws_lambda_permission" "bracket_init" {
  statement_id  = "AllowBracketInit"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ladder_scheduler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.bracket_init.arn
}

resource "aws_cloudwatch_event_rule" "round_advance" {
  name                = "codegladiator-round-advance-${var.environment}"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "round_advance" {
  rule      = aws_cloudwatch_event_rule.round_advance.name
  target_id = "ladder-scheduler-round-advance"
  arn       = aws_lambda_function.ladder_scheduler.arn
  input     = jsonencode({ trigger = "ROUND_ADVANCE" })
}

resource "aws_lambda_permission" "round_advance" {
  statement_id  = "AllowRoundAdvance"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ladder_scheduler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.round_advance.arn
}

# ─── Secrets Manager ─────────────────────────────────────────

resource "aws_secretsmanager_secret" "app_secrets" {
  name = "codegladiator/app-secrets-${var.environment}"
}

resource "aws_secretsmanager_secret_version" "app_secrets" {
  secret_id = aws_secretsmanager_secret.app_secrets.id
  secret_string = jsonencode({
    JWT_SECRET      = var.jwt_secret
    GEMINI_API_KEY = var.anthropic_api_key
    DATABASE_URL    = "postgres://postgres:${var.db_password}@${aws_db_instance.postgres.endpoint}/gladiator"
  })
}

# ─── Outputs ──────────────────────────────────────────────────

output "eks_cluster_name" {
  value = aws_eks_cluster.main.name
}

output "rds_endpoint" {
  value = aws_db_instance.postgres.endpoint
}

output "redis_endpoint" {
  value = aws_elasticache_cluster.redis.cache_nodes[0].address
}

output "s3_bucket" {
  value = aws_s3_bucket.submissions.id
}

output "execution_queue_url" {
  value = aws_sqs_queue.execution_queue.url
}

output "match_queue_url" {
  value = aws_sqs_queue.match_queue.url
}
