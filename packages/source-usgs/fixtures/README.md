# The fixtures of the USGS source

- `feed-2.5_day-20261116T0327Z.geojson` is a real answer of the USGS feed of the earthquakes of magnitude 2.5 or more of the past day. The USGS made it at 2026-11-16 03:27:30 UTC.
- The request asked for the whole feed, with no filter. The fixture holds each of the 48 events, from 6 networks.
- The feed holds 5 events with an intensity map. The tests use the M5.5 event `us7000tyek` in the Philippines (depth 9.971 km, MMI 6.399).
- The M3.5 event `aka2026wqrlbd` in Alaska has two ids: the id of the Alaska network and the id of the national network.
- `query-us6000jllz.geojson` is a real answer of the event query of the USGS, in the format of the feed. It holds the M7.8 event `us6000jllz` in Turkey on 2023-02-06 (depth 10 km, MMI 9.537). The request asked for the events of magnitude 7 or more from 01:17 to 01:18 UTC.
- `query-us2000aert.geojson` is a real answer of the event query of the USGS, in the format of the feed. It holds the M6.3 event `us2000aert` in North Korea on 2017-09-03, of the type `nuclear explosion` (depth 0 km, MMI 5.85). The request asked for the events of magnitude 6 or more from 03:30 to 03:31 UTC.
- `detail-us6000ude6.geojson` is a real answer of the detail of one event: the M4.1 event `us6000ude6` in Colorado on 2026-11-25 (depth 5 km, MMI 5.23), with each of its products.
- `shakemap-us6000ude6-mmi-low.covjson` is the real low-resolution grid of the intensity of that event, from its ShakeMap product (version 5). The grid has 51 by 51 points, and its strongest value is 4.9.
- The USGS data is in the U.S. public domain. Credit: U.S. Geological Survey.
