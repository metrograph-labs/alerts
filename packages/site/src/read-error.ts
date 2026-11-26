/**
 * The error of a failed read of the runtime, as data. A failed read gives a record of `@mark1russell7/otel-ts/error`,
 * and the local page shows the record in the shared error view. The view has a retry, a copy of the whole record and a
 * report. Thus a person can send the same record that the page shows.
 */

import { errorRecord, errorRecordText, type ErrorRecord } from "@mark1russell7/otel-ts/error";

/** The name of the error of a failed read. */
export const READ_ERROR_NAME = "RuntimeReadError";

/** The headline of the error view of a failed read, in plain words. */
export const READ_ERROR_SUMMARY = "The page cannot read the alert runtime.";

/** The address of a new report of a problem of this project. */
export const REPORT_ADDRESS = "https://github.com/metrograph-labs/alerts/issues/new";

/** The facts of one failed read. */
export interface ReadFailure {
  /** The words of the failure, from the reader of the route. */
  readonly text: string;
  /** The path of the route, for example `/map`. */
  readonly path: string;
  /** The URL path of the page. */
  readonly page: string;
  /** The time of the read. */
  readonly at?: Date;
}

/** This function gives the error record of a failed read. The procedure is the read of the route. */
export function readErrorRecord(failure: ReadFailure): ErrorRecord {
  const error = new Error(failure.text);
  error.name = READ_ERROR_NAME;
  return errorRecord(error, {
    procedure: { name: `GET ${failure.path}` },
    attributes: { "url.path": failure.page, "runtime.route": failure.path },
    ...(failure.at === undefined ? {} : { at: failure.at }),
  });
}

/**
 * This function gives the address of a new report with the record in its body. The record holds no secret, because the
 * record redacts each text. The person sees the report before the send.
 */
export function reportAddress(record: ErrorRecord): string {
  const address = new URL(REPORT_ADDRESS);
  address.searchParams.set("title", `${READ_ERROR_SUMMARY} (${record.procedure?.name ?? record.name})`);
  address.searchParams.set("body", ["The local page showed this error.", "", "```", errorRecordText(record), "```"].join("\n"));
  return address.href;
}
