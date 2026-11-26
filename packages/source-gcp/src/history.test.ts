import { describe, expect, it } from "vitest";

import { GLOBAL_LOCATION, readIncidentHistory, VM_PRODUCTS } from "./history.ts";

// The incidents of this file are made up. They use the fields of the history file of a dashboard.

const compute = VM_PRODUCTS[0]!;

const body = JSON.stringify([
  {
    id: "incident-b",
    begin: "2026-08-20T15:40:00+00:00",
    end: "2026-08-20T19:20:00+00:00",
    severity: "high",
    status_impact: "SERVICE_OUTAGE",
    affected_products: [{ title: compute.name, id: compute.id }, { title: compute.name, id: compute.id }],
    currently_affected_locations: [],
    previously_affected_locations: [{ title: "Global", id: GLOBAL_LOCATION }, { title: "Region (europe-west1)", id: "europe-west1" }],
  },
  {
    id: "incident-a",
    created: "2026-03-01T10:00:00+00:00",
    severity: "medium",
    status_impact: "SERVICE_DISRUPTION",
    affected_products: [{ title: "Some Product", id: "product-x" }],
    currently_affected_locations: [{ title: "Region (europe-west2)", id: "europe-west2" }],
    previously_affected_locations: [{ title: "Region (europe-west2)", id: "europe-west2" }],
  },
  { severity: "high", begin: "2026-01-01T00:00:00+00:00" },
  "not a record",
]);

describe("the history of a dashboard", () => {
  it("reads each incident with an id and a start, and the start of the oldest", () => {
    const history = readIncidentHistory(body);
    expect(history?.incidents.map((incident) => incident.id)).toEqual(["incident-b", "incident-a"]);
    expect(history?.since).toBe(Date.parse("2026-03-01T10:00:00Z"));
    const [outage, open] = history?.incidents ?? [];
    expect(outage).toEqual({
      id: "incident-b",
      severity: "high",
      impact: "SERVICE_OUTAGE",
      start: Date.parse("2026-08-20T15:40:00Z"),
      end: Date.parse("2026-08-20T19:20:00Z"),
      products: [compute.id],
      locations: [GLOBAL_LOCATION, "europe-west1"],
    });
    // An incident with no end has not ended. The start falls back to the field created. A location is not twice.
    expect(open?.end).toBeUndefined();
    expect(open?.locations).toEqual(["europe-west2"]);
  });

  it("gives no history for a body that is not a JSON list, and no start for an empty list", () => {
    expect(readIncidentHistory("{}")).toBeUndefined();
    expect(readIncidentHistory("not json")).toBeUndefined();
    expect(readIncidentHistory("[]")).toEqual({ incidents: [], since: undefined });
  });
});
