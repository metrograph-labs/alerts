import { CAP_MESSAGE_SYSTEM, incidents, normalize, Problems, reportId, type Observation, type ObservationId, type Report, type SourceId } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGES } from "./info.ts";
import { readCap } from "./read.ts";
import { capReports, type CapReportOptions } from "./report.ts";

const SOURCE = "test-cap" as SourceId;
const OPTIONS: CapReportOptions = { source: SOURCE, origin: "nws", keyed: true, languages: DEFAULT_LANGUAGES };
const SENT = "2026-11-15T12:00:00-00:00";
const SENT_MS = Date.parse(SENT);

/** One info block of a made-up message. The places are public zones of a Kansas office. */
interface Block {
  readonly event: string;
  readonly severity: string;
  readonly area: string;
  readonly ugc: string;
  readonly vtec?: string;
  readonly language?: string;
  readonly expires?: string;
}

const blockText = (block: Block): string =>
  `<info>${block.language === undefined ? "" : `<language>${block.language}</language>`}<category>Met</category><event>${block.event}</event>` +
  `<urgency>Expected</urgency><severity>${block.severity}</severity><certainty>Likely</certainty>` +
  `${block.expires === undefined ? "" : `<expires>${block.expires}</expires>`}` +
  `${block.vtec === undefined ? "" : `<parameter><valueName>VTEC</valueName><value>${block.vtec}</value></parameter>`}` +
  `<area><areaDesc>${block.area}</areaDesc><geocode><valueName>UGC</valueName><value>${block.ugc}</value></geocode></area></info>`;

const messageText = (identifier: string, blocks: readonly Block[], sent = SENT, head = "<msgType>Alert</msgType>"): string =>
  `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>${identifier}</identifier><sender>alerts@example.org</sender><sent>${sent}</sent>` +
  `<status>Actual</status>${head}<scope>Public</scope>${blocks.map(blockText).join("")}</alert>`;

/** A warning, an advisory and a watch in one message, as a tsunami center of the NWS sends them. */
const THREE: readonly Block[] = [
  { event: "Winter Storm Warning", severity: "Severe", area: "Zone A", ugc: "KSZ083", vtec: "/O.NEW.KICT.WS.W.0005.261115T1200Z-261116T1200Z/" },
  { event: "Winter Weather Advisory", severity: "Minor", area: "Zone B", ugc: "KSZ082", vtec: "/O.NEW.KICT.WW.Y.0009.261115T1200Z-261116T1200Z/" },
  { event: "Winter Storm Watch", severity: "Moderate", area: "Zone C", ugc: "KSZ081", vtec: "/O.NEW.KICT.WS.A.0006.261116T0000Z-261117T0000Z/" },
];

const observe = (body: string): Observation => ({
  id: `observation-${String(body.length)}` as ObservationId,
  source: SOURCE,
  fetched: SENT_MS + 60_000,
  contentType: "application/xml",
  body,
  transport: { url: "https://cap.test/alerts", status: 200, latency: 0 },
});

/** This function maps one CAP text with the options, and gives the reports and the problems. */
function mapText(body: string, options: CapReportOptions = OPTIONS): { reports: Report[]; problems: Problems } {
  const read = readCap(body);
  if (!read.ok) throw new Error(`the test message is not CAP: ${read.reason}`);
  const problems = new Problems();
  return { reports: capReports(read.alert, observe(body), options, problems), problems };
}

const codesOf = (report: Report): string[] => report.areas.flatMap((area) => (area.type === "code" ? [`${area.system}:${area.code}`] : []));

describe("the reports of one CAP message", () => {
  it("gives no report for a message with a scope other than Public, and a note that does not change the health (AL-92)", () => {
    for (const scope of ["Private", "Restricted"]) {
      const { reports, problems } = mapText(messageText("TEST-S", THREE).replace("<scope>Public</scope>", `<scope>${scope}</scope>`));
      expect(reports).toEqual([]);
      expect(problems.list).toEqual([{ path: "scope", message: expect.stringContaining(JSON.stringify(scope)), fatal: false }]);
    }
    expect(mapText(messageText("TEST-S", THREE).replace("<scope>Public</scope>", "<scope>public</scope>")).reports).toHaveLength(3);
  });

  it("maps the Public message of a fetch with one Restricted message, and counts no fatal and no lossy problem (AL-92)", () => {
    const restricted = mapText(messageText("TEST-R", THREE).replace("<scope>Public</scope>", "<scope>Restricted</scope>"));
    const open = mapText(messageText("TEST-P", THREE));
    expect([...restricted.reports, ...open.reports].map((report) => report.key)).toEqual(["TEST-P", "TEST-P", "TEST-P"]);
    // A fetch sums these two counts of each message. With 0 and 0, the health of the source stays as it is.
    expect(restricted.problems.fatal + open.problems.fatal).toBe(0);
    expect(restricted.problems.lossy + open.problems.lossy).toBe(0);
    expect([...restricted.problems.list, ...open.problems.list].map((problem) => problem.path)).toEqual(["scope"]);
  });

  it("gives one report for each block, with the key of the message and the part of the block in its id", () => {
    const { reports, problems } = mapText(messageText("TEST-3", THREE));
    expect(problems.list).toEqual([]);
    expect(reports.map((report) => report.key)).toEqual(["TEST-3", "TEST-3", "TEST-3"]);
    expect(reports.map((report) => report.id)).toEqual([0, 1, 2].map((index) => reportId({ source: SOURCE, key: "TEST-3", sent: SENT_MS, part: `info[${String(index)}]` })));
    expect(reports.map(codesOf)).toEqual([["ugc:KSZ083"], ["ugc:KSZ082"], ["ugc:KSZ081"]]);
    expect(reports.map((report) => report.areaText)).toEqual(["Zone A", "Zone B", "Zone C"]);
    expect(reports.map((report) => report.severity)).toEqual(["severe", "minor", "moderate"]);
    // Each block has its own VTEC and its own part, so each report has its own two correlation keys.
    expect(reports.map((report) => report.correlation.map((key) => key.system))).toEqual([0, 1, 2].map(() => ["vtec", CAP_MESSAGE_SYSTEM]));
    expect(new Set(reports.flatMap((report) => report.correlation.map((key) => key.id))).size).toBe(6);
    // Keyed areas: each area has the path of its own block.
    expect(reports.map((report) => report.areas.map((area) => (area.type === "place" ? "" : area.block)))).toEqual([["info[0].area[0]"], ["info[1].area[0]"], ["info[2].area[0]"]]);
  });

  it("joins the blocks of a message in one incident with one line for each block, and a later reference ends each block", () => {
    const { reports } = mapText(messageText("TEST-3", THREE));
    const at = SENT_MS + 3_600_000;
    const [incident, ...others] = incidents(normalize({ reports }), at);
    expect(others).toEqual([]);
    expect(incident?.live).toBe(true);
    expect(new Set(incident?.reports)).toEqual(new Set(reports.map((report) => report.id)));
    expect(incident?.lines?.map((line) => line.severity).sort()).toEqual(["minor", "moderate", "severe"]);

    const cancel = mapText(
      messageText(
        "TEST-4",
        [{ event: "Winter Weather Advisory", severity: "Minor", area: "Zone B", ugc: "KSZ082", vtec: "/O.CAN.KICT.WW.Y.0009.000000T0000Z-261116T1200Z/" }],
        "2026-11-15T12:30:00-00:00",
        `<msgType>Cancel</msgType><references>alerts@example.org,TEST-3,${SENT}</references>`,
      ),
    ).reports;
    expect(cancel).toHaveLength(1);
    const ended = incidents(normalize({ reports: [...reports, ...cancel] }), at);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.live).toBe(false);
  });

  it("keeps the id of a report with no part for a message of one block in the chosen language", () => {
    const blocks: Block[] = [{ ...THREE[0]!, language: "en-US" }, { ...THREE[1]!, language: "es-US" }];
    const { reports, problems } = mapText(messageText("TEST-1", blocks));
    expect(problems.list).toEqual([]);
    expect(reports.map((report) => report.id)).toEqual([reportId({ source: SOURCE, key: "TEST-1", sent: SENT_MS })]);
  });

  it("gives the reports of the blocks of the chosen language only, in the order of the message", () => {
    const languages = fc.array(fc.constantFrom("en-US", "es-US"), { minLength: 1, maxLength: 6 });
    fc.assert(
      fc.property(languages, (order) => {
        const blocks = order.map((language, index): Block => ({ ...THREE[index % THREE.length]!, language }));
        const { reports } = mapText(messageText("TEST-P", blocks));
        const chosen = order.includes("en-US") ? "en-US" : "es-US";
        const indexes = order.flatMap((language, index) => (language === chosen ? [index] : []));
        const parts = indexes.map((index) => (indexes.length > 1 ? `info[${String(index)}]` : undefined));
        expect(reports.map((report) => report.id)).toEqual(parts.map((part) => reportId({ source: SOURCE, key: "TEST-P", sent: SENT_MS, part })));
        expect(new Set(reports.map((report) => report.id)).size).toBe(indexes.length);
        expect(reports.every((report) => report.key === "TEST-P")).toBe(true);
      }),
    );
  });

  it("gives a note for an expires time before the sent time, and keeps the value", () => {
    const { reports, problems } = mapText(messageText("TEST-E", [{ ...THREE[1]!, expires: "2026-11-15T00:30:00-00:00" }]));
    expect(reports[0]?.expires).toBe(Date.parse("2026-11-15T00:30:00Z"));
    expect(problems.list).toEqual([{ path: "info[0].expires", message: "the expires time is before the sent time, so the report is not live", fatal: false }]);
  });

  it("gives one report with no area and a lossy problem for a message with no info block", () => {
    const { reports, problems } = mapText(messageText("TEST-0", []));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ key: "TEST-0", areas: [], id: reportId({ source: SOURCE, key: "TEST-0", sent: SENT_MS }) });
    expect(problems.list).toEqual([{ path: "info", message: "the message has no info block: the report has no kind and no area", fatal: false, lossy: true }]);
  });

  it("gives no report for an acknowledgment, and a fatal problem for a message with no identifier", () => {
    expect(mapText(messageText("TEST-A", THREE, SENT, "<msgType>Ack</msgType>")).reports).toEqual([]);
    const { reports, problems } = mapText(messageText("", THREE));
    expect(reports).toEqual([]);
    expect(problems.fatal).toBe(1);
  });

  it("gives areas with no key when the areas are not keyed", () => {
    const { reports } = mapText(messageText("TEST-3", THREE), { ...OPTIONS, keyed: false });
    expect(reports.flatMap((report) => report.areas.map((area) => (area.type === "place" ? "" : area.block ?? "none")))).toEqual(["none", "none", "none"]);
  });
});

describe("the fire zones of a CAP message (AL-33)", () => {
  // A made-up Red Flag Warning for public zones of a Kansas office.
  const noVtec = (ugc: string): Block => ({ event: "Red Flag Warning", severity: "Severe", area: "Zone A", ugc });
  const redFlag = (ugc: string): Block => ({ ...noVtec(ugc), vtec: "/O.NEW.KICT.FW.W.0004.261118T1800Z-261119T0300Z/" });

  it("gives a fire zone code for a zone code of an alert with the VTEC phenomenon FW", () => {
    const { reports } = mapText(messageText("TEST-FW-1", [redFlag("KSZ083")]));
    expect(reports.map(codesOf)).toEqual([["ugc-fire:KSZ083"]]);
  });

  it("keeps a county code, a value of an unknown form and the codes of another phenomenon in the system ugc", () => {
    const codes = (block: Block): string[] => mapText(messageText("TEST-FW-2", [block])).reports.flatMap(codesOf);
    expect(codes(redFlag("KSC173"))).toEqual(["ugc:KSC173"]);
    expect(codes(redFlag("KS-Z-083"))).toEqual(["ugc:KS-Z-083"]);
    expect(codes(noVtec("KSZ083"))).toEqual(["ugc:KSZ083"]);
    expect(codes({ ...redFlag("KSZ083"), event: "Wind Advisory", vtec: "/O.NEW.KICT.WI.Y.0004.261118T1800Z-261119T0300Z/" })).toEqual(["ugc:KSZ083"]);
  });
});
