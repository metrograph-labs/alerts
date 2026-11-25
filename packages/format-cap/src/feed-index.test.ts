import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readCapIndex, type CapIndexRead } from "./feed-index.ts";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

/** The real indexes (`fixtures/index/README.md`). */
const NIUE = fixture("index/nu-gov-en.rss.xml");
const DWD = fixture("index/dwd-en.atom.xml");
const GEONET = fixture("index/geonet-quake.atom.xml");

const HUB = "https://cap-sources.s3.amazonaws.com/nu-gov-en";

const atom = (entries: string, head = 'xmlns="http://www.w3.org/2005/Atom"'): string => `<?xml version="1.0"?><feed ${head}><id>urn:test</id>${entries}</feed>`;
const rss = (items: string, version = "2.0"): string => `<?xml version="1.0"?><rss version="${version}"><channel><title>t</title>${items}</channel></rss>`;

const entriesOf = (read: CapIndexRead) => (read.ok ? read.entries : []);
const problemsOf = (read: CapIndexRead) => (read.ok ? read.problems : []);

describe("readCapIndex", () => {
  it("reads the RSS index of the Niue feed: one entry for each item, with its guid, its link and its time", () => {
    const read = readCapIndex(NIUE);
    expect(read).toMatchObject({ ok: true, format: "rss", problems: [] });
    expect(entriesOf(read)).toEqual([
      { id: "urn:oid:2.49.0.1.570.0.2026.10.23.0.31.33", link: `${HUB}/2026-10-23-00-31-33.xml`, updated: "Fri, 23 Oct 2026 00:31:33 +0000" },
      { id: "urn:oid:2.49.0.1.570.0.2026.10.16.1.37.10", link: `${HUB}/2026-10-16-01-37-10.xml`, updated: "Fri, 16 Oct 2026 01:37:10 +0000" },
      { id: "urn:oid:2.49.0.1.570.0.2026.10.15.23.2.27", link: `${HUB}/2026-10-15-23-02-27.xml`, updated: "Thu, 15 Oct 2026 23:02:27 +0000" },
      { id: "urn:oid:2.49.0.1.570.0.2026.10.9.2.38.33", link: `${HUB}/2026-10-09-02-38-33.xml`, updated: "Fri, 09 Oct 2026 02:38:33 +0000" },
      { id: "urn:oid:2.49.0.1.570.0.2026.10.8.23.18.3", link: `${HUB}/2026-10-08-23-18-03.xml`, updated: "Thu, 08 Oct 2026 23:18:03 +0000" },
    ]);
  });

  it("reads the Atom index of the DWD: the CAP link of each entry, with its id and its time", () => {
    const read = readCapIndex(DWD);
    expect(read).toMatchObject({ ok: true, format: "atom", problems: [] });
    const entries = entriesOf(read);
    expect(entries).toHaveLength(36);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(36);
    for (const entry of entries) {
      expect(entry.link).toMatch(/^https:\/\/www\.dwd\.de\/DWD\/warnungen\/cap-feed\/en\/[^/]+\.ENG\.xml$/);
      // The id of each entry of the DWD is the URL of its message.
      expect(entry.id).toBe(entry.link);
      // The index keeps each warning in effect, also a warning of an earlier day.
      expect(entry.updated).toMatch(/^2026-11-1[56]T\d\d:\d\d:00Z$/);
    }
  });

  it("reads the same entries from the CRLF line ends of the DWD answer and from the LF line ends of the repository", () => {
    const lf = DWD.replaceAll("\r\n", "\n");
    const crlf = lf.replaceAll("\n", "\r\n");
    expect(crlf).not.toBe(lf);
    expect(readCapIndex(crlf)).toEqual(readCapIndex(lf));
  });

  it("reads the empty Atom index of GeoNet as an index with no entry", () => {
    expect(readCapIndex(GEONET)).toEqual({ ok: true, format: "atom", entries: [], problems: [] });
  });

  it("chooses the link of an Atom entry: the CAP media type first, then the relation alternate or no relation", () => {
    const read = readCapIndex(
      atom(
        [
          '<entry><id>a</id><link rel="alternate" type="text/html" href="https://x.test/a.html"/><link rel="related" type="application/cap+xml" href="https://x.test/a.xml"/></entry>',
          '<entry><id>b</id><link href="https://x.test/b.xml"/></entry>',
          '<entry><id>c</id><link rel="self" href="https://x.test/c"/><link rel="alternate" href="https://x.test/c.xml"/></entry>',
          '<entry><id>d</id><link rel="self" href="https://x.test/d"/></entry>',
          '<entry><id>e</id><published>2026-11-16T00:00:00Z</published><link href="https://x.test/e.xml?b=1&amp;c=2"/></entry>',
        ].join(""),
      ),
    );
    expect(entriesOf(read)).toEqual([
      { id: "a", link: "https://x.test/a.xml" },
      { id: "b", link: "https://x.test/b.xml" },
      { id: "c", link: "https://x.test/c.xml" },
      { id: "e", link: "https://x.test/e.xml?b=1&c=2", updated: "2026-11-16T00:00:00Z" },
    ]);
    expect(problemsOf(read)).toEqual([{ path: "entry[3]", message: "the entry has no link to a CAP message", fatal: false, lossy: true }]);
  });

  it("chooses the link of an RSS item: the link, then an enclosure of the CAP media type, then a guid that is a permanent URL", () => {
    const read = readCapIndex(
      rss(
        [
          "<item><guid>g1</guid><link>https://x.test/1.xml</link></item>",
          '<item><guid>g2</guid><enclosure type="application/cap+xml" url="https://x.test/2.xml" length="1"/></item>',
          "<item><guid>https://x.test/3.xml</guid></item>",
          '<item><guid isPermaLink="false">https://x.test/4.xml</guid></item>',
          "<item><title>no link</title></item>",
          "<item><link>https://x.test/6.xml</link></item>",
        ].join(""),
      ),
    );
    expect(entriesOf(read)).toEqual([
      { id: "g1", link: "https://x.test/1.xml" },
      { id: "g2", link: "https://x.test/2.xml" },
      { id: "https://x.test/3.xml", link: "https://x.test/3.xml" },
      { id: "https://x.test/6.xml", link: "https://x.test/6.xml" },
    ]);
    expect(problemsOf(read).map((problem) => problem.path)).toEqual(["item[3]", "item[4]"]);
  });

  it("keeps the first entry of an id, with a note", () => {
    const read = readCapIndex(rss("<item><guid>g</guid><link>https://x.test/1.xml</link></item><item><guid>g</guid><link>https://x.test/2.xml</link></item>"));
    expect(entriesOf(read)).toEqual([{ id: "g", link: "https://x.test/1.xml" }]);
    expect(problemsOf(read)).toEqual([{ path: "item[1]", message: "the id g is not unique: the reader keeps the first item of the id", fatal: false }]);
  });

  it("gives a note for an RSS version that is not 2.0 and for a feed with no Atom namespace", () => {
    expect(problemsOf(readCapIndex(rss("", "0.91")))).toEqual([{ path: "rss", message: "the version of RSS is 0.91, not 2.0", fatal: false }]);
    expect(problemsOf(readCapIndex(atom("", "")))).toEqual([{ path: "feed", message: "the namespace of the feed is absent, not the namespace of Atom 1.0", fatal: false }]);
  });

  it("refuses a DOCTYPE, a text that is not well formed, a CAP message and an rss element with no channel", () => {
    expect(readCapIndex(`<!DOCTYPE rss [<!ENTITY e "x">]>${rss("")}`)).toMatchObject({ ok: false, reason: expect.stringContaining("DOCTYPE") });
    expect(readCapIndex(NIUE.slice(0, NIUE.indexOf("</channel>")))).toMatchObject({ ok: false, reason: expect.stringContaining("not well formed") });
    expect(readCapIndex(fixture("hub/oet-wind.xml"))).toMatchObject({ ok: false, reason: "the root element is cap:alert, not rss, rdf:RDF or an Atom feed" });
    expect(readCapIndex('<rss version="2.0"></rss>')).toEqual({ ok: false, reason: "the rss element has no channel" });
    expect(readCapIndex("")).toMatchObject({ ok: false });
  });

  it("refuses each cut of a real index before the end of its root, so a cut index is never a short index", () => {
    for (const text of [NIUE, DWD, GEONET]) {
      const end = text.lastIndexOf("</");
      fc.assert(
        fc.property(fc.integer({ min: 0, max: end }), (at) => {
          expect(readCapIndex(text.slice(0, at)).ok).toBe(false);
        }),
        { numRuns: 200 },
      );
    }
  });
});
