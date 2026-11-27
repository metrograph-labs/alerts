import { hasKind, type SourceDescriptor } from "@mark1russell7/alerts";
import { AWS_DESCRIPTOR } from "@mark1russell7/alerts-source-aws";
import { AZURE_DESCRIPTOR } from "@mark1russell7/alerts-source-azure";
import { BOM_SWS_DESCRIPTOR } from "@mark1russell7/alerts-source-bom-sws";
import { ANOMALIES_DESCRIPTOR, OUTAGES_DESCRIPTOR } from "@mark1russell7/alerts-source-cloudflare-radar";
import { KEV_DESCRIPTOR } from "@mark1russell7/alerts-source-cisa-kev";
import { CERT_PROVIDERS, certDescriptor } from "@mark1russell7/alerts-source-cert-feeds";
import { CSAF_PROVIDERS, csafDescriptor } from "@mark1russell7/alerts-source-csaf";
import { EMSC_DESCRIPTOR } from "@mark1russell7/alerts-source-emsc";
import { EIA_930_DESCRIPTOR } from "@mark1russell7/alerts-source-eia-930";
import { ENERGY_CHARTS_DESCRIPTOR } from "@mark1russell7/alerts-source-energy-charts";
import { FAA_DESCRIPTOR } from "@mark1russell7/alerts-source-faa";
import { NDW_DESCRIPTOR } from "@mark1russell7/alerts-source-ndw";
import { RAIL_DESCRIPTOR } from "@mark1russell7/alerts-source-digitraffic-rail";
import { FIREBASE_DESCRIPTOR, GCP_DESCRIPTOR } from "@mark1russell7/alerts-source-gcp";
import { FIRMS_DESCRIPTOR } from "@mark1russell7/alerts-source-firms";
import { GDELT_DESCRIPTOR } from "@mark1russell7/alerts-source-gdelt";
import { GFZ_DESCRIPTOR, HP30_DESCRIPTOR } from "@mark1russell7/alerts-source-gfz";
import { IEM_DESCRIPTOR } from "@mark1russell7/alerts-source-iem";
import { IPAWS_DESCRIPTOR } from "@mark1russell7/alerts-source-ipaws";
import { NWS_DESCRIPTOR } from "@mark1russell7/alerts-source-nws-api";
import { NWWS_DESCRIPTOR } from "@mark1russell7/alerts-source-nwws";
import { OSV_PROVIDERS, osvDescriptor } from "@mark1russell7/alerts-source-osv";
import { SWPC_DESCRIPTOR } from "@mark1russell7/alerts-source-swpc";
import { descriptorOf, TSUNAMI_CENTERS } from "@mark1russell7/alerts-source-tsunami";
import { USGS_DESCRIPTOR } from "@mark1russell7/alerts-source-usgs";
import { describe, expect, it } from "vitest";
import { readAtlas } from "./read.ts";

/** The descriptors of each adapter that the atlas adopts. A new adopted adapter needs a row here. */
const DESCRIPTORS: Readonly<Record<string, readonly SourceDescriptor[]>> = {
  "@mark1russell7/alerts-source-aws": [AWS_DESCRIPTOR],
  "@mark1russell7/alerts-source-azure": [AZURE_DESCRIPTOR],
  "@mark1russell7/alerts-source-bom-sws": [BOM_SWS_DESCRIPTOR],
  "@mark1russell7/alerts-source-cloudflare-radar": [OUTAGES_DESCRIPTOR, ANOMALIES_DESCRIPTOR],
  "@mark1russell7/alerts-source-cisa-kev": [KEV_DESCRIPTOR],
  "@mark1russell7/alerts-source-eia-930": [EIA_930_DESCRIPTOR],
  "@mark1russell7/alerts-source-emsc": [EMSC_DESCRIPTOR],
  "@mark1russell7/alerts-source-cert-feeds": CERT_PROVIDERS.map((provider) => certDescriptor(provider)),
  "@mark1russell7/alerts-source-csaf": CSAF_PROVIDERS.map((provider) => csafDescriptor(provider)),
  "@mark1russell7/alerts-source-energy-charts": [ENERGY_CHARTS_DESCRIPTOR],
  "@mark1russell7/alerts-source-faa": [FAA_DESCRIPTOR],
  "@mark1russell7/alerts-source-ndw": [NDW_DESCRIPTOR],
  "@mark1russell7/alerts-source-digitraffic-rail": [RAIL_DESCRIPTOR],
  "@mark1russell7/alerts-source-gcp": [GCP_DESCRIPTOR, FIREBASE_DESCRIPTOR],
  "@mark1russell7/alerts-source-firms": [FIRMS_DESCRIPTOR],
  "@mark1russell7/alerts-source-gdelt": [GDELT_DESCRIPTOR],
  "@mark1russell7/alerts-source-gfz": [GFZ_DESCRIPTOR, HP30_DESCRIPTOR],
  "@mark1russell7/alerts-source-iem": [IEM_DESCRIPTOR],
  "@mark1russell7/alerts-source-ipaws": [IPAWS_DESCRIPTOR],
  "@mark1russell7/alerts-source-nws-api": [NWS_DESCRIPTOR],
  "@mark1russell7/alerts-source-nwws": [NWWS_DESCRIPTOR],
  "@mark1russell7/alerts-source-osv": OSV_PROVIDERS.map((provider) => osvDescriptor(provider)),
  "@mark1russell7/alerts-source-swpc": [SWPC_DESCRIPTOR],
  "@mark1russell7/alerts-source-tsunami": [descriptorOf(TSUNAMI_CENTERS.ntwc), descriptorOf(TSUNAMI_CENTERS.ptwc)],
  "@mark1russell7/alerts-source-usgs": [USGS_DESCRIPTOR],
};

/** The kinds of the failure domains that the path of the atlas and the `dependsOn` of a descriptor both give. */
const SHARED_KINDS = ["cdn", "carrier"];
const prefixOf = (id: string): string | null => (id.includes(":") ? id.slice(0, id.indexOf(":")) : null);

const atlas = readAtlas();
const kinds = new Map(atlas.paths.map((part) => [part.id, part.kind]));
const adopted = atlas.sources.filter((source) => source.decision === "adopt");

/** The origins of a source of the atlas, with its regional origins. */
const originsOf = (source: (typeof adopted)[number]): readonly string[] => [...source.origins, ...(source.regionalOrigins ?? []).flatMap((entry) => entry.origins)];

/**
 * The descriptors of the adapter of an adopted source that share an origin with the source. One adapter can serve the
 * sources of different issuers, for example the providers of the CSAF adapter. Then each source has only its descriptors.
 * One adapter can also serve two paths of one issuer, for example the two feeds of the OSV adapter. Then a source with
 * the id of a descriptor has only that descriptor.
 */
const descriptorsOf = (source: (typeof adopted)[number]): readonly SourceDescriptor[] => {
  const all = DESCRIPTORS[source.adapter ?? ""] ?? [];
  const own = all.filter((descriptor) => descriptor.id === source.id);
  return own.length > 0 ? own : all.filter((descriptor) => descriptor.origins.some((origin) => originsOf(source).includes(origin)));
};

describe("the paths of the atlas and the descriptors of the adapters", () => {
  it("has the descriptors of each adopted adapter", () => {
    // Two sources can share one adapter, for example the two dashboards of Google.
    expect([...new Set(adopted.map((source) => source.adapter))].sort()).toEqual(Object.keys(DESCRIPTORS).sort());
  });

  // The adopted layers of the coverage count each class of an adopted source as a class that an adapter delivers.
  it("gives each class of an adopted source in the kinds of a descriptor of its adapter", () => {
    const missing = adopted.flatMap((source) => {
      const kinds = descriptorsOf(source).flatMap((descriptor) => descriptor.kinds);
      return source.classes
        .filter((name) => !hasKind(kinds, name))
        .map((name) => `no descriptor of ${source.adapter ?? "(none)"} gives the class ${name} of ${source.id}`);
    });
    expect(missing).toEqual([]);
  });

  // A kind of an adapter with no class in its records is a delivery that the coverage does not count.
  it("gives each kind of a descriptor a class of each adopted source of its adapter", () => {
    const missing = adopted.flatMap((source) =>
      descriptorsOf(source).flatMap((descriptor) =>
        descriptor.kinds
          .filter((kind) => !source.classes.some((name) => hasKind([kind], name) || hasKind([name], kind)))
          .map((kind) => `the classes of ${source.id} lack the kind ${kind} of ${descriptor.id}`),
      ),
    );
    expect(missing).toEqual([]);
  });

  // A shared CDN or carrier is a common fault of two sources. When one list lacks it, the coverage counts two sources as apart.
  it("gives each part of an adopted path that is not a host in the dependsOn of each descriptor of its adapter", () => {
    const missing = adopted.flatMap((source) =>
      descriptorsOf(source).flatMap((descriptor) =>
        source.path.filter((id) => kinds.get(id) !== "host" && !descriptor.dependsOn.includes(id)).map((id) => `${descriptor.id} lacks ${id} of ${source.id}`),
      ),
    );
    expect(missing).toEqual([]);
  });

  it("gives each CDN and carrier of the dependsOn of a descriptor in the path of its adopted source", () => {
    const missing = adopted.flatMap((source) =>
      descriptorsOf(source).flatMap((descriptor) =>
        descriptor.dependsOn
          .filter((id) => SHARED_KINDS.includes(prefixOf(id) ?? "") && !source.path.includes(id))
          .map((id) => `the path of ${source.id} lacks ${id} of ${descriptor.id}`),
      ),
    );
    expect(missing).toEqual([]);
  });

  it("gives each descriptor of an adapter an adopted source with an origin of the descriptor", () => {
    const missing = Object.entries(DESCRIPTORS).flatMap(([adapter, descriptors]) =>
      descriptors
        .filter((descriptor) => !adopted.some((source) => source.adapter === adapter && descriptorsOf(source).includes(descriptor)))
        .map((descriptor) => `no adopted source of ${adapter} has an origin of ${descriptor.id}`),
    );
    expect(missing).toEqual([]);
  });

  // An origin of a descriptor that the atlas does not give the source makes two reports of one issuer look apart.
  it("gives each origin of a descriptor in the origins of its adopted source", () => {
    const missing = adopted.flatMap((source) =>
      descriptorsOf(source).flatMap((descriptor) =>
        descriptor.origins
          .filter((origin) => !source.origins.includes(origin) && !(source.regionalOrigins ?? []).some((entry) => entry.origins.includes(origin)))
          .map((origin) => `the origins of ${source.id} lack ${origin} of ${descriptor.id}`),
      ),
    );
    expect(missing).toEqual([]);
  });

  // A measure of a dimension that the atlas does not give the source is a cover that the atlas does not count.
  it("gives the dimension of each measure of a descriptor in the dimensions of its adopted source", () => {
    const missing = adopted.flatMap((source) =>
      descriptorsOf(source).flatMap((descriptor) =>
        (descriptor.measures ?? [])
          .filter((measure) => source.dimensions?.includes(measure.dimension) !== true)
          .map((measure) => `the dimensions of ${source.id} lack ${measure.dimension} of the measure ${measure.id} of ${descriptor.id}`),
      ),
    );
    expect(missing).toEqual([]);
  });
});
