import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The three pages of the alert texts. The toll-free verification of the texts links to each one, and the carriers refuse a
// form when a page lacks a required statement.
const NAMES = ["privacy", "terms", "opt-in"] as const;
const html = (name: string): string => readFileSync(new URL(`../texts/${name}/index.html`, import.meta.url), "utf8");
const pages = new Map(NAMES.map((name) => [name, html(name)]));
// The visible text of a page: no tags, and each run of white space as one space.
const text = (name: string): string =>
  pages
    .get(name as (typeof NAMES)[number])!
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
// The made-up number of the sample record. The pages hold no other phone number.
const SAMPLE_NUMBER = "+15550100123";

describe("the pages of the alert texts", () => {
  it("has the theme button and the entry, with no inline script and no inline style", () => {
    for (const [name, page] of pages) {
      expect(page, name).toContain('id="theme"');
      expect(page, name).toContain('<script type="module" src="../../src/texts.ts"></script>');
      expect(page, name).not.toMatch(/\sstyle="|\son[a-z]+="|<style|<script>/i);
    }
    expect(readFileSync(new URL("./texts.ts", import.meta.url), "utf8")).toContain('setupTheme(byId<HTMLButtonElement>("theme"), "theme");');
  });

  it("links each page to the two other pages and to the support page", () => {
    for (const [name, page] of pages) {
      for (const other of NAMES.filter((entry) => entry !== name)) expect(page, name).toContain(`href="../${other}/"`);
      expect(page, name).toContain('href="https://github.com/metrograph-labs/alerts/issues"');
    }
  });

  it("holds no email address and no phone number other than the made-up number of the sample", () => {
    for (const [name, page] of pages) {
      expect(page, name).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
      const numbers = [...page.matchAll(/\+\d{8,15}|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g)].map((match) => match[0]);
      expect(numbers.filter((number) => number !== SAMPLE_NUMBER), name).toEqual([]);
    }
    // The number of the sample is in the range 555-0100 to 555-0199, which no person gets.
    expect(SAMPLE_NUMBER).toMatch(/^\+1555010\d{4}$/);
  });

  it("gives the statements of the privacy policy", () => {
    const privacy = text("privacy");
    expect(privacy).toContain(
      "No mobile information will be shared with third parties/affiliates for marketing/promotional purposes. All the above categories exclude text messaging originator opt-in data and consent; this information will not be shared with any third parties.",
    );
    expect(privacy).toContain("The program never sells, rents or trades a phone number.");
    expect(privacy).toContain("Reply STOP to a text.");
  });

  it("gives the statements of the terms", () => {
    const terms = text("terms");
    for (const statement of [
      "Program name: alerts.",
      "Message frequency varies.",
      "Message and data rates may apply.",
      "Reply STOP to cancel.",
      "Reply START to get the texts again.",
      "Reply HELP for help.",
      "Carriers are not liable for delayed or undelivered messages.",
    ]) {
      expect(terms).toContain(statement);
    }
  });

  it("gives the consent words and a sample record with each field", () => {
    const optIn = text("opt-in");
    expect(optIn).toContain("Version texts-consent/1");
    for (const statement of ["Message frequency varies.", "Message and data rates may apply.", "Reply STOP to cancel and HELP for help.", "Consent is not a condition of any purchase."]) {
      expect(optIn).toContain(statement);
    }
    const record = /<pre class="record"><code>([\s\S]*?)<\/code><\/pre>/.exec(pages.get("opt-in")!)?.[1];
    expect(JSON.parse(record ?? "null")).toEqual({ number: SAMPLE_NUMBER, at: "2026-11-17T21:30:00Z", way: "written", words: "texts-consent/1" });
  });

  it("is in the build and in the browser check of the site", () => {
    const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    for (const name of NAMES) expect(vite).toContain(`page("texts/${name}/index.html")`);
    // The site config of the repository gives the pages of the browser check to the shared workflows of the template.
    const site = JSON.parse(readFileSync(new URL("../../../.github/site.json", import.meta.url), "utf8")) as { readonly "site-check-pages"?: string };
    expect(site["site-check-pages"]?.split(",")).toEqual(["/", "/releases/", "/status/", "/texts/privacy/", "/texts/terms/", "/texts/opt-in/"]);
  });
});
