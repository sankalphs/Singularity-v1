import "server-only";

import {
  buildSpacetimeFeedbackUrl,
  readFeedbackInboxEmail,
  readResendConfig,
  type FeedbackSubmission,
} from "@/lib/feedback";
import {
  FeedbackStorageError,
  persistFeedbackRequest,
  sendFeedbackForwardRequest,
  sendFeedbackThankYouRequest,
} from "@/lib/feedback-transports";

export { FeedbackStorageError };

export async function persistFeedback(submission: FeedbackSubmission): Promise<void> {
  let endpoint: string;
  try {
    endpoint = buildSpacetimeFeedbackUrl(process.env);
  } catch {
    throw new FeedbackStorageError("SpacetimeDB is not configured correctly.");
  }

  await persistFeedbackRequest(submission, endpoint);
}

export type ThankYouResult =
  | { status: "accepted"; emailId: string }
  | { status: "failed"; reason: "configuration" | "provider" | "transport" };

export async function sendFeedbackThankYou(submission: FeedbackSubmission): Promise<ThankYouResult> {
  const config = readResendConfig(process.env);
  if (!config) return { status: "failed", reason: "configuration" };

  return sendFeedbackThankYouRequest(submission, config);
}

export async function forwardFeedbackToInbox(submission: FeedbackSubmission): Promise<ThankYouResult> {
  const config = readResendConfig(process.env);
  const inbox = readFeedbackInboxEmail(process.env);
  if (!config || !inbox) return { status: "failed", reason: "configuration" };

  return sendFeedbackForwardRequest(submission, inbox, config);
}
