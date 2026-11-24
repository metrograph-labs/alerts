import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

describe("the entry", () => {
  it("exports the requester and the map of failures", () => {
    expect(Object.keys(entry).sort()).toEqual(["DEFAULT_MIN_INTERVAL_MS", "DEFAULT_TIMEOUT_MS", "MAX_DETAIL", "createRequester", "failureOf", "problemDetail"]);
  });
});
