/**
 * The register of well-known status pages. Each page gave a summary with a list of incidents to a probe on 2026-11-18.
 * The pages of Atlassian Statuspage gave an `ETag`. The page of incident.io gave none. The page of StatusIQ gave its feed,
 * with no `ETag`.
 *
 * The kind of a page is the kind of its service. The service is an online service, a cloud platform, a provider of DNS,
 * delivery or certificates, or a payment service. It can also be a bank, a broker, a crypto exchange or a blockchain.
 */

import type { SourceId } from "@mark1russell7/alerts";

import { endpointKey, regionKey, type ComponentKey, type StatusPage } from "./page.ts";

/** The failure domain of each page that Atlassian Statuspage hosts. */
export const ATLASSIAN_STATUSPAGE = "provider:atlassian-statuspage";

/** The failure domain of each page that incident.io hosts. */
export const INCIDENT_IO = "provider:incident-io";

/** The failure domain of each page that Site24x7 StatusIQ hosts. The host of such a page is an alias of `site24x7sp.com`. */
export const STATUSIQ = "provider:site24x7-statusiq";

/** The failure domain of a page behind the delivery network of Cloudflare. */
export const CLOUDFLARE_CDN = "cdn:cloudflare";

const SAAS = "infra.saas.outage";
const CLOUD = "infra.cloud.outage";
const DNS_CDN = "infra.internet.dns-cdn";
const PAYMENTS = "infra.payments.outage";
const BANK = "market.bank.outage";
const BROKER = "market.broker.outage";
const EXCHANGE = "market.crypto.exchange-outage";
const CHAIN = "market.crypto.chain-halt";

/** This function gives the config of one page: its id is `statuspage-` and the name. */
const page = (name: string, title: string, host: string, domain: string, kind: string, dependsOn: readonly string[] = [ATLASSIAN_STATUSPAGE], origin = name): StatusPage => ({
  id: `statuspage-${name}` as SourceId,
  title,
  base: `https://${host}`,
  origin,
  domain,
  kind,
  dependsOn,
});

/**
 * The keys of the components of Twilio on the path of an alert call or text message. These are the SMS and the API of
 * the messages, and Functions. For the voice of US1, these are the REST API, the PSTN, TwiML and the text to speech. The
 * outage call starts Functions on the server of Twilio. The API of these services is `api.twilio.com`. Each id is a
 * component of the page on 2026-11-18.
 *
 * Each component of the group CARRIER NETWORK for messages or voice names the path of its region and its product, for
 * example `provider-region:twilio/europe/sms`. In North America, the kind of number is a part below the product, for
 * example `twilio/north-america/sms/short-code`. Thus a channel of the SMS of North America gets an outage of each kind of
 * number. An outage of Twilio Video or SendGrid names only `twilio.com`.
 */
export const TWILIO_KEYS: readonly ComponentKey[] = [
  endpointKey("yvvy3vlp4djf", "SMS", "api.twilio.com"),
  endpointKey("x3z86l06nvl7", "Programmable Messaging API", "api.twilio.com"),
  endpointKey("mwcz6hw53t7c", "Voice REST API US1", "api.twilio.com"),
  endpointKey("g2dt752kwqs0", "PSTN US1", "api.twilio.com"),
  endpointKey("xnzrm2zg4qbv", "TwiML US1", "api.twilio.com"),
  endpointKey("dv0j99s68yxn", "Text-to-Speech US1", "api.twilio.com"),
  endpointKey("b3tl520cz8tc", "Functions", "api.twilio.com"),
  regionKey("7d8w22hqrh6s", "SMS Long Code, North America", "twilio/north-america/sms/long-code"),
  regionKey("8vdlvw3dsq8h", "MMS Long Code, North America", "twilio/north-america/mms/long-code"),
  regionKey("39mb8cmw8y2v", "SMS Short Code, North America", "twilio/north-america/sms/short-code"),
  regionKey("h0fl7prwfhvm", "MMS Short Code, North America", "twilio/north-america/mms/short-code"),
  regionKey("32f2bm54nkvv", "SMS Toll-Free, North America", "twilio/north-america/sms/toll-free"),
  regionKey("tvjwfvczkf46", "MMS Toll-Free, North America", "twilio/north-america/mms/toll-free"),
  regionKey("2v3v92mz2m4h", "Voice, North America", "twilio/north-america/voice"),
  regionKey("fbtv2g9t3z25", "Voice, Latin America", "twilio/latin-america/voice"),
  regionKey("42zx9w2kmtvf", "SMS, Latin America", "twilio/latin-america/sms"),
  regionKey("50pr269zqrwj", "Voice, APAC", "twilio/apac/voice"),
  regionKey("8qjql0kqnd33", "SMS, APAC", "twilio/apac/sms"),
  regionKey("2nd0jdj36wpq", "MMS, APAC", "twilio/apac/mms"),
  regionKey("bnzggd37p61w", "Voice, Europe", "twilio/europe/voice"),
  regionKey("llgdln3dcs6p", "SMS, Europe", "twilio/europe/sms"),
  regionKey("6ns22g89f6g9", "Voice, Middle East & Africa", "twilio/middle-east-africa/voice"),
  regionKey("9z5gsqyjs4rl", "SMS, Middle East & Africa", "twilio/middle-east-africa/sms"),
];

/**
 * The keys of the components of Pushover that deliver a message: the queue of outbound messages and the four servers of
 * the API. The API of these components is `api.pushover.net`. Each id is a component of the page on 2026-11-18. An outage
 * of the dashboard names only `pushover.net`.
 */
export const PUSHOVER_KEYS: readonly ComponentKey[] = [
  endpointKey("Xt5Xa7RUGZkb8L55acKKAdKJSFNX3IWXJvaVT3vKiIeFeuT8A-avC5Z0nJZirwB6", "Outbound Message Queue", "api.pushover.net"),
  endpointKey("Xt5Xa7RUGZkb8L55acKKAdKJSFNX3IWXJvaVT3vKiIcnWztijJIDzxTWBujQEd3M", "US Central (F)", "api.pushover.net"),
  endpointKey("Xt5Xa7RUGZkb8L55acKKAdKJSFNX3IWXJvaVT3vKiIeiu-9ysiEgekUK3gEuk9hO", "US Central (T)", "api.pushover.net"),
  endpointKey("Xt5Xa7RUGZkb8L55acKKAdKJSFNX3IWXJvaVT3vKiIfTbKS2mFwt4hT84B6JuyjD", "US West (A)", "api.pushover.net"),
  endpointKey("Xt5Xa7RUGZkb8L55acKKAdKJSFNX3IWXJvaVT3vKiIcrDRsdTbAIJSMnDRKdrfEZ", "US West (H)", "api.pushover.net"),
];

/** The well-known status pages, in the order of their ids. */
export const STATUS_PAGES: readonly StatusPage[] = [
  page("bitbucket", "Bitbucket", "bitbucket.status.atlassian.com", "bitbucket.org", SAAS, [ATLASSIAN_STATUSPAGE], "atlassian"),
  page("box", "Box", "status.box.com", "box.com", SAAS),
  page("chime", "Chime", "status.chime.com", "chime.com", BANK),
  page("circle", "Circle", "status.circle.com", "circle.com", EXCHANGE),
  page("circleci", "CircleCI", "status.circleci.com", "circleci.com", SAAS),
  page("claude", "Claude", "status.claude.com", "claude.ai", SAAS, [ATLASSIAN_STATUSPAGE], "anthropic"),
  page("cloudflare", "Cloudflare", "www.cloudflarestatus.com", "cloudflare.com", DNS_CDN),
  page("coinbase", "Coinbase", "status.coinbase.com", "coinbase.com", EXCHANGE, [ATLASSIAN_STATUSPAGE, CLOUDFLARE_CDN]),
  page("digicert", "DigiCert", "status.digicert.com", "digicert.com", DNS_CDN),
  page("digitalocean", "DigitalOcean", "status.digitalocean.com", "digitalocean.com", CLOUD, [ATLASSIAN_STATUSPAGE, CLOUDFLARE_CDN]),
  page("discord", "Discord", "discordstatus.com", "discord.com", SAAS),
  page("dropbox", "Dropbox", "status.dropbox.com", "dropbox.com", SAAS),
  page("elastic", "Elastic Cloud", "status.elastic.co", "elastic.co", CLOUD),
  page("epicgames", "Epic Games", "status.epicgames.com", "epicgames.com", SAAS),
  page("figma", "Figma", "status.figma.com", "figma.com", SAAS),
  page("gemini", "Gemini Exchange", "status.gemini.com", "gemini.com", EXCHANGE),
  page("github", "GitHub", "www.githubstatus.com", "github.com", SAAS),
  page("hubspot", "HubSpot", "status.hubspot.com", "hubspot.com", SAAS),
  page("kraken", "Kraken", "status.kraken.com", "kraken.com", EXCHANGE),
  page("linode", "Linode", "status.linode.com", "linode.com", CLOUD),
  page("mailgun", "Mailgun", "status.mailgun.com", "mailgun.com", SAAS),
  page("netlify", "Netlify", "www.netlifystatus.com", "netlify.com", CLOUD),
  page("newrelic", "New Relic", "status.newrelic.com", "newrelic.com", SAAS),
  page("npm", "npm", "status.npmjs.org", "npmjs.com", SAAS),
  // The summary of this page has no list of incidents since 2026-11-25. The list of the latest incidents has them.
  { ...page("openai", "OpenAI", "status.openai.com", "openai.com", SAAS, [INCIDENT_IO]), format: "incident-list" },
  { ...page("pushover", "Pushover", "status.pushover.net", "pushover.net", SAAS, [STATUSIQ]), format: "statusiq", components: PUSHOVER_KEYS },
  page("reddit", "Reddit", "www.redditstatus.com", "reddit.com", SAAS),
  page("render", "Render", "status.render.com", "render.com", CLOUD),
  page("robinhood", "Robinhood", "status.robinhood.com", "robinhood.com", BROKER),
  page("sentry", "Sentry", "status.sentry.io", "sentry.io", SAAS),
  page("shopify", "Shopify", "www.shopifystatus.com", "shopify.com", SAAS),
  page("snowflake", "Snowflake", "status.snowflake.com", "snowflake.com", CLOUD),
  page("solana", "Solana", "status.solana.com", "solana.com", CHAIN),
  { ...page("twilio", "Twilio", "status.twilio.com", "twilio.com", SAAS), components: TWILIO_KEYS },
  page("vercel", "Vercel", "www.vercel-status.com", "vercel.com", CLOUD),
  page("visa-acceptance", "Visa Acceptance Solutions", "status.visaacceptance.com", "visaacceptance.com", PAYMENTS, [ATLASSIAN_STATUSPAGE], "visa"),
];

/** This function gives the page of the register with the id `id`, or `undefined`. */
export function registeredPage(id: string): StatusPage | undefined {
  return STATUS_PAGES.find((each) => each.id === id);
}
