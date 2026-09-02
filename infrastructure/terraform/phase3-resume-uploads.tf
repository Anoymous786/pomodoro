###############################################################################
# phase3-resume-uploads.tf
#
# S3 bucket (private) + S3 event notifications that trigger the extractor.
#
# Flow: browser asks get-upload-url for a pre-signed PUT -> uploads DIRECTLY
# to S3 (the API never proxies file bytes) -> ObjectCreated fires the
# resume-extractor Lambda, which writes extracted/<key>.json next to it.
###############################################################################

locals {
  # One notification config per extension keeps filters simple and explicit.
  resume_extensions = ["txt", "md", "csv", "pdf", "docx"]
}

resource "aws_s3_bucket" "resumes" {
  # Account id appended because bucket names are GLOBAL.
  bucket        = "${var.project}-resumes-${local.account_id}"
  force_destroy = true # demo hygiene: terraform destroy wipes everything

  tags = { Name = "${var.project}-resumes" }
}

resource "aws_s3_bucket_public_access_block" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256" # SSE-S3, free
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  rule {
    id     = "abort-stale-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }

  rule {
    id     = "expire-demo-objects"
    status = "Enabled"

    filter {}

    # Everything in this bucket is transient demo data; keep it 30 days.
    expiration { days = 30 }
  }
}

# The extractor may only read/write through its least-privilege role.
resource "aws_lambda_permission" "s3_invoke_extractor" {
  statement_id   = "AllowS3ObjectCreated"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.fn["resume-extractor"].function_name
  principal      = "s3.amazonaws.com"
  source_arn     = aws_s3_bucket.resumes.arn
  source_account = local.account_id
}

resource "aws_s3_bucket_notification" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  dynamic "lambda_function" {
    for_each = local.resume_extensions

    content {
      lambda_function_arn = aws_lambda_function.fn["resume-extractor"].arn
      events              = ["s3:ObjectCreated:*"]
      filter_suffix       = ".${lambda_function.value}"
    }
  }

  # Avoid the classic race where the notification references the permission
  # before AWS has propagated it (would leave the bucket in a stuck state).
  depends_on = [aws_lambda_permission.s3_invoke_extractor]
}