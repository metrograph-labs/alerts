/**
 * The descriptor of each OSV provider. The rows of `OSV_PROVIDERS` give the values. A provider is a stream: a record
 * stays until the end that the map gives to it.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import type { OsvProvider } from "./providers.ts";

/** This function gives the descriptor of one provider. */
export function osvDescriptor(provider: OsvProvider): SourceDescriptor {
  return {
    id: provider.id,
    title: provider.title,
    origins: [provider.origin],
    dependsOn: provider.dependsOn,
    uses: ["internet", "dns", "power"],
    kinds: [provider.kind],
    coverage: "global",
    transport: "poll",
    interval: provider.interval,
    slowAfter: provider.slowAfter,
    maxQuiet: provider.maxAge,
    auth: "none",
    canary: provider.canary,
  };
}
