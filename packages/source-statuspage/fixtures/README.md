# The fixtures of the status-page source

- `cloudflare-20261118.json` comes from the real answer to `https://www.cloudflarestatus.com/api/v2/summary.json`. The site sent it at 2026-11-18 04:34:02 UTC.
- The real answer had all the components of the page. The fixture keeps the 5 components that the incidents name, with no change. The other fields are the real fields.
- The fixture keeps the 2 incidents and their updates with no change. One incident is in the state `monitoring`, and the other is in the state `identified`.
- The fixture keeps 2 of the scheduled maintenances. The source makes no report of a maintenance.
- The answer had `Content-Type: application/json` and an `ETag`. Atlassian Statuspage hosts the page.
- `openai-20261118.json` comes from the real answer to `https://status.openai.com/api/v2/summary.json`. The site sent it at 2026-11-18 04:53:17 UTC.
- The fixture keeps 4 components and the one incident, with no change. The incident has no `shortlink`, no `started_at` and no components.
- The answer had `Content-Type: application/json` and no `ETag`. incident.io hosts the page.
- `openai-incidents-20261125.json` comes from the real answer to `https://status.openai.com/api/v2/incidents.json`. The site sent it at 2026-11-25 16:20 UTC.
- The real answer had 25 incidents. The fixture keeps the head of the page and the 2 latest incidents with no change. Both are in the state `resolved`.
- On that day the summary of the page had only `page`, `status` and `components`, with no list of incidents. The tests make an open incident from this list, and each such test tells it.
- `twilio-incidents-20261118.json` comes from the real answer to `https://status.twilio.com/api/v2/incidents.json`. The site sent it at 2026-11-18 14:24:25 UTC.
- The real answer had 50 incidents. The fixture keeps the head of the page and 2 incidents with no change. The incident `269ytwp2jgqq` is on the path of an alert, and `smg76w4fhp05` is of a carrier in APAC.
- Both incidents are in the state `resolved`. The answer had `Content-Type: application/json` and an `ETag`.
- Cloudflare, OpenAI and Twilio own the texts of their incidents. The texts are short notices of the operation of a service.
- The answers contain no personal data. The JSON fixtures have an indent of 2 spaces.

## Pushover

- `pushover-20261118.xml` is the real answer to `https://status.pushover.net/rss` on 2026-11-18, byte for byte. Site24x7 StatusIQ hosts the page.
- The feed has 6 items, one for each component. Each component was `Operational`. The tests make an outage from this feed, and each such test tells it.
- The answer had `Content-Type: application/rss+xml;charset=utf-8`, `Cache-Control: no-store` and no `ETag`. The host had no `robots.txt` file.
- The `guid` of an item is the time of the item in base64. It is not unique. The id of a component is the end of its link.
- Pushover owns the texts of the feed. The feed contains no personal data.
