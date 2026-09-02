/**
 * roadmap-worker  (Phase 4, SQS-triggered) — thin event adapter.
 * Business logic lives in ./process-job.mjs.
 *
 * Errors thrown by a record are reported via ReportBatchItemFailures so ONLY
 * that message retries (maxReceiveCount 3 -> DLQ -> Phase-6 alarm).
 */
import { processJob } from "./process-job.mjs";

export const handler = async (event) => {
  const batchItemFailures = [];
  for (const record of event.Records ?? []) {
    try {
      await processJob(JSON.parse(record.body));
    } catch (err) {
      console.error(`Job failed (${record.messageId}):`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};