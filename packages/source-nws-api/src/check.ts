/**
 * The canary check of the NWS API source. The NWS sends a keepalive test message each 10 minutes
 * (AWIPS id `KEPWBC`). A recent keepalive proves that the full path of the NWS works: the alert
 * system of the NWS, the API and the network.
 */

import type { CanaryResult, Observation } from "@mark1russell7/alerts";
import { isKeepalive, keepaliveCheck } from "@mark1russell7/alerts-format-nws";
import { isRecord, timeOf } from "@mark1russell7/optional/read";

export { KEEPALIVE_MAX_AGE_MS } from "@mark1russell7/alerts-format-nws";

/** This function gives the sent time of a keepalive in an observation. Another observation gives `undefined`. */
export function keepaliveSent(observation: Observation): number | undefined {
  let feature: unknown;
  try {
    feature = JSON.parse(observation.body);
  } catch {
    return undefined;
  }
  if (!isRecord(feature) || !isRecord(feature["properties"])) return undefined;
  const record = feature["properties"];
  const parameters = isRecord(record["parameters"]) ? record["parameters"] : {};
  const awips = Array.isArray(parameters["AWIPSidentifier"]) ? parameters["AWIPSidentifier"] : [];
  const id = typeof record["id"] === "string" ? record["id"] : undefined;
  return isKeepalive(id, awips.filter((one) => typeof one === "string")) ? timeOf(record, "sent") : undefined;
}

/**
 * This function examines the observations of one fetch against the canary. The check passes when
 * the newest keepalive is at most `KEEPALIVE_MAX_AGE_MS` older than its fetch. The rule is `keepaliveCheck` of format-nws.
 * The function is pure.
 */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  let newest: { readonly sent: number; readonly fetched: number } | undefined;
  for (const observation of observations) {
    const sent = keepaliveSent(observation);
    if (sent !== undefined && (newest === undefined || sent > newest.sent)) newest = { sent, fetched: observation.fetched };
  }
  return keepaliveCheck(newest);
}
