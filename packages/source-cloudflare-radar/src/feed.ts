/**
 * The facts of the API of Cloudflare Radar: the host, the two lists, the ids of the two sources and the subjects of the
 * cloud regions.
 *
 * Cloudflare Radar gives two lists. The outage center is a list of outages that the analysts of Cloudflare confirm,
 * with a cause and a scope. The traffic anomalies are the drops of traffic that a model of Cloudflare finds in a
 * country, a network or a cloud region. An anomaly can name the outage of the analysts.
 */

import { AWS_DOMAIN, REGION_PROVIDER as AWS_PROVIDER } from "@mark1russell7/alerts-source-aws";
import { AZURE_DOMAIN, REGION_PROVIDER as AZURE_PROVIDER } from "@mark1russell7/alerts-source-azure";
import { GCP_DOMAIN, REGION_PROVIDER as GCP_PROVIDER } from "@mark1russell7/alerts-source-gcp";
import type { Duration, SourceId, SubjectSystem } from "@mark1russell7/alerts";

/** The id of the source of the outages. */
export const OUTAGES_SOURCE = "cloudflare-radar-outages" as SourceId;

/** The id of the source of the traffic anomalies. */
export const ANOMALIES_SOURCE = "cloudflare-radar-anomalies" as SourceId;

/** The issuer of each report. */
export const RADAR_ORIGIN = "cloudflare";

/** The base URL of the API of Cloudflare Radar. */
export const RADAR_BASE = "https://api.cloudflare.com/client/v4/radar";

/**
 * The size of one page of a list. A day has a few records, and a page with this count of records is not complete. The
 * API accepts this value.
 */
export const PAGE_LIMIT = 100;

/**
 * The path of the outages of the last day. The API gives each outage whose time overlaps the window. Thus the list
 * holds each outage with no end.
 */
export const OUTAGES_PATH: string = `/annotations/outages?dateRange=1d&limit=${PAGE_LIMIT}&format=json`;

/** The path of the traffic anomalies of the last day. The API gives each anomaly whose time overlaps the window. */
export const ANOMALIES_PATH: string = `/traffic_anomalies?dateRange=1d&limit=${PAGE_LIMIT}&format=json`;

/** The page of the outage center for a person. */
export const OUTAGE_CENTER = "https://radar.cloudflare.com/outage-center";

/** The page of the traffic anomalies for a person. */
export const ANOMALIES_PAGE = "https://radar.cloudflare.com/traffic";

/** The failure domain of the API outside the cell. Cloudflare serves the API from its own network. */
export const RADAR_PROVIDER = "provider:cloudflare";

/** The time between two fetches of each list. The answers of the API stay in a cache for some minutes. */
export const RADAR_INTERVAL: Duration = 600_000;

/** The time after which a request is slow. */
export const RADAR_SLOW_AFTER: Duration = 15_000;

/** The kind of an outage or an anomaly of a country, a region or a network. */
export const OUTAGE_KIND = "infra.internet.outage";

/** The kind of an outage that an authority ordered (the cause `GOVERNMENT_DIRECTED`). */
export const SHUTDOWN_KIND = "infra.internet.shutdown";

/** The kind of an outage of a platform (the scope `PLATFORM`) and of an anomaly of a cloud region (the type `ORIGIN`). */
export const CLOUD_KIND = "infra.cloud.outage";

/**
 * The kind of a collapse of a power grid: a nationwide outage with the cause `POWER_OUTAGE`. The outage gives this report
 * in addition to its report of the internet outage.
 */
export const GRID_COLLAPSE_KIND = "infra.power.grid-collapse";

/** The kinds of the outages. The anomalies give only the internet and cloud outages. */
export const RADAR_KINDS: readonly string[] = [OUTAGE_KIND, SHUTDOWN_KIND, CLOUD_KIND, GRID_COLLAPSE_KIND];

/** The system of the shared key of an outage. An anomaly that names the outage gives the same key. */
export const OUTAGE_KEY_SYSTEM = "cloudflare-radar-outage";

/** The subject system of a network: the number of the autonomous system. */
export const ASN_SYSTEM: SubjectSystem = "asn";

/** The subject system of a cloud region, for example `azure/westeurope`. */
export const REGION_SYSTEM: SubjectSystem = "provider-region";

/** The subject system of the domain of a cloud provider. */
export const DOMAIN_SYSTEM: SubjectSystem = "domain";

/** The area system of a country: the code of ISO 3166-1 alpha-2. */
export const COUNTRY_SYSTEM = "iso3166";

/** The area system of a region of a country: the id of GeoNames. */
export const GEONAMES_SYSTEM = "geonames";

/** One cloud provider of the origins of Radar. */
export interface CloudProvider {
  /** The provider part of the id of a region, for example `azure`. */
  readonly region: string;
  /** The domain of the service, when a source package of the provider gives one. The domains are the same. */
  readonly domain?: string;
  /** The name of the provider in a label. */
  readonly name: string;
}

/**
 * The cloud providers for each prefix of an origin of Radar. An origin is the prefix and the region, for example
 * `google-europe-west2`. The domains and the provider parts of the ids come from the source packages of each provider.
 * No source reads Oracle Cloud, so it has no domain.
 */
export const CLOUD_PROVIDERS: Readonly<Record<string, CloudProvider>> = {
  google: { region: GCP_PROVIDER, domain: GCP_DOMAIN, name: "Google Cloud" },
  amazon: { region: AWS_PROVIDER, domain: AWS_DOMAIN, name: "AWS" },
  microsoft: { region: AZURE_PROVIDER, domain: AZURE_DOMAIN, name: "Microsoft Azure" },
  oracle: { region: "oci", name: "Oracle Cloud" },
};

/**
 * The names of the regions of Azure that differ in Radar. Radar names a region of Azure with the short name of its
 * service tag, for example `centralfrance`. The status page of Azure and `source-azure` use the name of the region,
 * for example `francecentral`. Each other name is the same in the two.
 */
export const AZURE_ALIASES: Readonly<Record<string, string>> = {
  centralfrance: "francecentral",
  southfrance: "francesouth",
  germanywc: "germanywestcentral",
  germanyn: "germanynorth",
  norwaye: "norwayeast",
  norwayw: "norwaywest",
  switzerlandn: "switzerlandnorth",
  switzerlandw: "switzerlandwest",
  brazilse: "brazilsoutheast",
  chilec: "chilecentral",
};

/** The cloud region of one origin of Radar. */
export interface OriginRegion {
  readonly provider: CloudProvider;
  /** The id of the subject, for example `gcp/europe-west2`. */
  readonly id: string;
}

/**
 * This function gives the cloud region of an origin of Radar, or `undefined` for an origin with an unknown prefix. A
 * region of Azure gets its name from `AZURE_ALIASES` when the names differ.
 */
export function originRegion(origin: string): OriginRegion | undefined {
  const dash = origin.indexOf("-");
  if (dash <= 0 || dash === origin.length - 1) return undefined;
  const provider = CLOUD_PROVIDERS[origin.slice(0, dash)];
  if (provider === undefined || !Object.hasOwn(CLOUD_PROVIDERS, origin.slice(0, dash))) return undefined;
  const region = origin.slice(dash + 1);
  const name = provider.region === AZURE_PROVIDER && Object.hasOwn(AZURE_ALIASES, region) ? AZURE_ALIASES[region]! : region;
  return { provider, id: `${provider.region}/${name}` };
}
