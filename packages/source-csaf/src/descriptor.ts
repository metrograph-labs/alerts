/**
 * The descriptor of each CSAF provider. The rows of `CSAF_PROVIDERS` give the values. A provider is a stream: an advisory
 * stays until the end that the map gives to it.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import type { CsafProvider } from "./providers.ts";

/** This function gives the descriptor of one provider. */
export function csafDescriptor(provider: CsafProvider): SourceDescriptor {
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
    slowAfter: 10_000,
    maxQuiet: provider.maxAge,
    auth: "none",
    canary: provider.canary,
  };
}
