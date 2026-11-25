/**
 * The signal core of the alert system. It holds the contracts of the event, the source and the
 * channel. It also holds the id functions, the merge, the first assessment and the escalation. It
 * holds the health of the sources, the lateness across sources, the coverage, the system reports and
 * the view of the map. It holds the checks of the indicator readings and the read of each indicator series.
 *
 * It holds the taxonomy of the kinds, and the lifelines and the needs of a person. The map functions put
 * their problems in its collector.
 * `docs/CONTRACTS.md` explains them.
 */
export * from "./contracts.ts";
export * from "./ids.ts";
export * from "./merge.ts";
export * from "./retention.ts";
export * from "./assess.ts";
export * from "./moving.ts";
export * from "./place-holds.ts";
export * from "./state-codes.ts";
export * from "./audience.ts";
export * from "./score.ts";
export * from "./escalation.ts";
export * from "./chain.ts";
export * from "./channel-down.ts";
export * from "./clock-step.ts";
export * from "./delivery.ts";
export * from "./digest.ts";
export * from "./send-limit.ts";
export * from "./observe.ts";
export * from "./throttle.ts";
export * from "./drill.ts";
export * from "./why.ts";
export * from "./config.ts";
export * from "./opt-in.ts";
export * from "./health.ts";
export * from "./coverage.ts";
export * from "./lateness.ts";
export * from "./copy-measure.ts";
export * from "./link.ts";
export * from "./basemap.ts";
export * from "./health-payload.ts";
export * from "./history.ts";
export * from "./indicators.ts";
export * from "./baseline.ts";
export * from "./breadth.ts";
export * from "./threat.ts";
export * from "./history-reader.ts";
export * from "./map.ts";
export * from "./problems.ts";
export * from "./interest-defaults.ts";
export * from "./interests-payload.ts";
export * from "./relevance.ts";
export * from "./schemas.ts";
export * from "./shapes.ts";
export * from "./system-reports.ts";
export * from "./taxonomy.ts";
export * from "./lifelines.ts";
