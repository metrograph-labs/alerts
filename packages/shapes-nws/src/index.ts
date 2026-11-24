/**
 * The store of the outlines of the NWS counties and forecast zones, for the map of the alert system.
 * The store gets the outlines from the zone service of the NWS API and keeps them in a cache. It gives
 * the lookup of the view of the map and the basemap of each state.
 *
 * @packageDocumentation
 */
export { memoryCache, openShapeCache, SHAPES_FILE, type FileShapeCache, type MemoryRecords, type ShapeCache, type ShapeRecords } from "./cache.ts";
export { dropsOf, listKey, plan, taskId, zoneKey, type CachedList, type CachedZone, type Plan, type PlanInput, type ShapeState, type Task, type Wanted, type ZoneHead } from "./plan.ts";
export { zoneCodesNear } from "./near.ts";
export { createShapeStore, HOST_RETRY_MS, REFRESH_MS, RETRY_MS, type RefreshInput, type Refreshed, type ShapeStore, type ShapeStoreOptions, type TaskFailure } from "./store.ts";
export { compareCodes, listPath, readList, readZone, ZONE_KINDS, zoneKindOf, zoneOfCode, zonePath, type ReadList, type ReadZone, type ZoneKey, type ZoneKind } from "./zones.ts";
