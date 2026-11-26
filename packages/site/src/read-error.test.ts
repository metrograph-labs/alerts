import { callTrace } from "@mark1russell7/otel-ts/call-trace";
import { ERROR_RECORD_FORMAT } from "@mark1russell7/otel-ts/error";
import { describe, expect, it } from "vitest";
import { NO_ANSWER_TEXT } from "./map-read.ts";
import { READ_ERROR_NAME, READ_ERROR_SUMMARY, readErrorRecord, REPORT_ADDRESS, reportAddress } from "./read-error.ts";

const at = new Date("2026-11-25T12:00:00.000Z");

describe("the error record of a failed read", () => {
  it("keeps the words of the reader, the route, the page and the time", () => {
    const record = readErrorRecord({ text: NO_ANSWER_TEXT, path: "/map", page: "/alerts/local.html", at });
    expect(record.format).toBe(ERROR_RECORD_FORMAT);
    expect(record.name).toBe(READ_ERROR_NAME);
    expect(record.message).toBe(NO_ANSWER_TEXT);
    expect(record.procedure).toEqual({ name: "GET /map" });
    expect(record.attributes).toEqual({ "url.path": "/alerts/local.html", "runtime.route": "/map" });
    expect(record.at).toBe(at.toISOString());
    expect(record.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("gives a different id to each record", () => {
    const failure = { text: NO_ANSWER_TEXT, path: "/map", page: "/" };
    expect(readErrorRecord(failure).id).not.toBe(readErrorRecord(failure).id);
  });

  // The page has no SDK. callTrace gives the read its trace, and the record of the failed read has the same ids.
  it("has the trace id and the span id of the traceparent of the read", () => {
    const call = callTrace();
    const record = readErrorRecord({ text: NO_ANSWER_TEXT, path: "/map", page: "/alerts/local.html", at, from: call.context });
    expect(call.headers.traceparent).toBe(`00-${record.traceId}-${record.spanId}-01`);
    expect(record.sampled).toBe(true);
  });

  it("has no trace id with no call trace and no SDK", () => {
    expect(readErrorRecord({ text: NO_ANSWER_TEXT, path: "/map", page: "/" }).traceId).toBeUndefined();
  });
});

describe("the address of a report", () => {
  it("opens a new report of this project with the whole record in its body", () => {
    const record = readErrorRecord({ text: "This page reads the alert runtime on this computer. The runtime answers with the status 404.", path: "/map", page: "/alerts/local.html", at });
    const address = new URL(reportAddress(record));
    expect(`${address.origin}${address.pathname}`).toBe(REPORT_ADDRESS);
    expect(address.searchParams.get("title")).toBe(`${READ_ERROR_SUMMARY} (GET /map)`);
    const body = address.searchParams.get("body") ?? "";
    expect(body).toContain(`${READ_ERROR_NAME}: This page reads the alert runtime on this computer. The runtime answers with the status 404.`);
    expect(body).toContain(`Record: ${record.id}`);
    expect(body).toContain("Procedure: GET /map");
  });
});
