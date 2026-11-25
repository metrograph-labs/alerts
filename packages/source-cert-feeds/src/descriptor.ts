/**
 * The descriptor of each CERT feed. The rows of `CERT_PROVIDERS` give the values. A feed is a stream: a report stays until
 * the end that the map gives to it.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import type { CertProvider } from "./providers.ts";

/** This function gives the descriptor of one provider. */
export function certDescriptor(provider: CertProvider): SourceDescriptor {
  return {
    id: provider.id,
    title: provider.title,
    origins: [provider.origin],
    dependsOn: provider.dependsOn,
    uses: ["internet", "dns", "power"],
    kinds: provider.kinds,
    coverage: "global",
    transport: "poll",
    interval: provider.interval,
    slowAfter: 10_000,
    maxQuiet: provider.maxAge,
    auth: "none",
    canary: provider.canary,
  };
}
