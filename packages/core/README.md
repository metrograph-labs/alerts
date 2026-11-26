# @mark1russell7/alerts

The signal core of an alert system. It holds the contracts of the event, the source and the channel, and the calculations over them.

The core names no person and no place. The people, the places and the keys of a user are input data.

## Install

```sh
npm install @mark1russell7/alerts
```

The package needs Node.js 22 or later. It is an ES module.

## What the package holds

| Area | What it does |
| --- | --- |
| Contracts | The event format, based on CAP (the Common Alerting Protocol), and the contracts of a source adapter and a channel. |
| Ids and merge | The id of each report and of each incident. The merge of duplicate reports is idempotent and does not change with the order. |
| Assessment | The first assessment of an incident, its score, its audience and the record that tells why. |
| Escalation | The chain of the steps of a route, the acknowledgement, the send limits, the digest and the drills. |
| Sources | The health and the coverage of each source, the lag of each feed, the canary limits from the measured publish times, the lateness across sources and the system reports. |
| Kinds | The taxonomy of the kinds of an alert, with a lock file of the codes. |
| Lifelines and needs | The 8 FEMA Community Lifelines, and the needs of a person each day with an official source for each amount. |
| Indicators | The checks of the indicator readings and the read of each indicator series. |
| Map | The view of the map, the shapes and the base map. |

## Example

```ts
import { LIFELINES, LIFELINE_LABELS, NEEDS, kindLabel } from "@mark1russell7/alerts";

for (const code of LIFELINES) console.log(code, LIFELINE_LABELS[code]);
for (const need of NEEDS) console.log(need.code, need.perPersonDay, need.unit, need.source.url);
console.log(kindLabel("other.unknown"));
```

## Stability

The version is below 1.0.0. Thus a minor version can change the API. The file `test/api/public-api.txt` holds the report of the API.

## Documents

- [The contracts](https://github.com/metrograph-labs/alerts/blob/main/docs/CONTRACTS.md) tell each type and each rule of the core.
- [The roadmap](https://github.com/metrograph-labs/alerts/blob/main/docs/ROADMAP.md) tells the plan of the work.

## License

MIT
