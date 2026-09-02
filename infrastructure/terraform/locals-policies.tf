###############################################################################
# locals-policies.tf — capability -> least-privilege IAM statements
#
# Each statement is scoped to ARNs this stack creates, so no function can
# touch another stack's resources even if its code were compromised.
###############################################################################

locals {
  cap_policies = {
    # Read LLM provider config + API keys from Parameter Store.
    # SecureString needs kms:Decrypt against the AWS-managed aws/ssm key —
    # the condition pins that to the single AWS-managed SSM key alias.
    llm_keys = [
      {
        Sid      = "ReadPomodoroSsm"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParametersByPath"]
        Resource = "arn:${local.partition}:ssm:${local.region_name}:${local.account_id}:parameter/pomodoro/*"
      },
      {
        Sid       = "DecryptAwsManagedSsmKeyOnly"
        Effect    = "Allow"
        Action    = "kms:Decrypt"
        Resource  = "*"
        Condition = { StringEquals = { "kms:ResourceAliases" = "alias/aws/ssm" } }
      }
    ]

    ddb_roadmaps_rw = [{
      Sid    = "RoadmapsTableReadWrite"
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
        "dynamodb:Query", "dynamodb:DeleteItem", "dynamodb:TransactWriteItems"
      ]
      Resource = [aws_dynamodb_table.roadmaps.arn]
    }]

    ddb_roadmaps_ro = [{
      Sid      = "RoadmapsTableReadOnly"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:Query"]
      Resource = [aws_dynamodb_table.roadmaps.arn]
    }]

    # Search uses Scan+Filter instead of a GSI/OpenSearch cluster.
    ddb_search = [{
      Sid      = "RoadmapsScanForTopicSearch"
      Effect   = "Allow"
      Action   = ["dynamodb:Scan", "dynamodb:Query"]
      Resource = [aws_dynamodb_table.roadmaps.arn]
    }]

    ddb_cache_rw = [{
      Sid      = "LlmCacheTableReadWrite"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
      Resource = [aws_dynamodb_table.llm_cache.arn]
    }]

    sqs_send = [{
      Sid      = "EnqueueRoadmapJobs"
      Effect   = "Allow"
      Action   = ["sqs:SendMessage", "sqs:GetQueueAttributes"]
      Resource = [aws_sqs_queue.roadmap_jobs.arn]
    }]

    sqs_consume = [{
      Sid      = "ConsumeRoadmapJobs"
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = [aws_sqs_queue.roadmap_jobs.arn]
    }]

    sns_publish = [{
      Sid      = "PublishRoadmapEvents"
      Effect   = "Allow"
      Action   = ["sns:Publish"]
      Resource = [aws_sns_topic.events.arn]
    }]

    s3_presign = [{
      Sid      = "PresignResumeUploadsOnly"
      Effect   = "Allow"
      Action   = ["s3:PutObject"]
      Resource = ["${aws_s3_bucket.resumes.arn}/uploads/*"]
    }]

    s3_extracted_read = [{
      Sid      = "ReadExtractedResumeText"
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = ["${aws_s3_bucket.resumes.arn}/extracted/*"]
    }]

    s3_uploads_read = [{
      Sid      = "ReadUploadedResumes"
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = ["${aws_s3_bucket.resumes.arn}/uploads/*"]
    }]

    s3_extracted_write = [{
      Sid      = "WriteExtractedResumeText"
      Effect   = "Allow"
      Action   = ["s3:PutObject"]
      Resource = ["${aws_s3_bucket.resumes.arn}/extracted/*"]
    }]

    # Phase 4: focus-logs lambda may WRITE ONLY to the focus_sessions table.
    ddb_focus_rw = [{
      Sid      = "FocusSessionsWrite"
      Effect   = "Allow"
      Action   = ["dynamodb:PutItem"]
      Resource = [aws_dynamodb_table.focus_sessions.arn]
    }]
  }
}