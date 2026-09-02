/**
 * shared/aws.mjs — lazily-created AWS service clients + Parameter Store
 * secret resolution.
 *
 * The nodejs20.x Lambda runtime bundles the AWS SDK for JavaScript v3, so
 * these imports need NO npm install and NO bundling step. Only the
 * resume-extractor carries a dependency in its zip.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  SQSClient,
  SendMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const ddbClient = new DynamoDBClient({});
/** Document client marshals JS objects <-> DynamoDB attribute values.
 *  removeUndefinedValues keeps optional fields (e.g. absent resumeText)
 *  out of items — matches the old localStorage JSON semantics. */
export const doc = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export const ssm = new SSMClient({});
export const s3 = new S3Client({});
export const sqs = new SQSClient({});
export const sns = new SNSClient({});

// Re-export the commands each function needs so handlers stay tidy.
export {
  GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand,
  TransactWriteCommand, GetParameterCommand, GetObjectCommand,
  PutObjectCommand, SendMessageCommand, DeleteMessageCommand, PublishCommand,
  getSignedUrl,
};

/**
 * Resolves an LLM API key:
 *   1. plain env var (local `node -e` testing / emergency override),
 *   2. Parameter Store SecureString at envKeyParam (encrypted with the
 *      AWS-managed aws/ssm KMS key — free forever, unlike Secrets Manager).
 * Values are cached per execution environment to avoid a parameter read on
 * every invocation.
 */
const paramCache = new Map();

export async function resolveSecret(envName, envParamName) {
  if (process.env[envName]) return process.env[envName];

  const paramName = process.env[envParamName];
  if (!paramName) {
    throw new Error(`${envName} is not set and no ${envParamName} was provided.`);
  }
  if (paramCache.has(paramName)) return paramCache.get(paramName);

  const out = await ssm.send(
    new GetParameterCommand({ Name: paramName, WithDecryption: true })
  );
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`Parameter ${paramName} exists but has no value.`);
  paramCache.set(paramName, value);
  return value;
}

/** Same pattern for non-secret config (LLM provider). */
export async function resolveConfig(envName, envParamName, fallback = "") {
  if (process.env[envName]) return process.env[envName];
  const paramName = process.env[envParamName];
  if (!paramName) return fallback;
  if (paramCache.has(paramName)) return paramCache.get(paramName);
  const out = await ssm.send(new GetParameterCommand({ Name: paramName }));
  const value = out.Parameter?.Value ?? fallback;
  paramCache.set(paramName, value);
  return value;
}

/** Reads an S3 object body fully into a UTF-8 string. */
export async function readS3ObjectToString(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.concat(await res.Body.transformToByteArray()).toString("utf8");
}
