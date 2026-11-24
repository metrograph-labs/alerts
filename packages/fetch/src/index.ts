/**
 * This package holds the fetch parts that the sources of the alert system share. Each source asks
 * its servers through polite-crawler. The first part is the requester: one GET or one POST at the
 * pace of the host, with a time limit. The second part is the map from an answer to a failure of a fetch. The third part
 * is the store of the last full answer of each URL, for the replay of a 304 answer.
 */

export { failureOf, MAX_DETAIL, problemDetail, type Detail } from "./failure.ts";
export {
  createRequester,
  type ConditionalGet,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  type Post,
  type Request,
  type RequestPath,
  type Requested,
  type Requester,
  type RequesterOptions,
} from "./request.ts";
export { answerStore, type AnswerStore, type KeptAnswer } from "./replay.ts";
