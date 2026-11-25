# The fixtures of the NDW source

- `actueel-beeld-20261125T0112Z.xml` holds real text of the file `https://opendata.ndw.nu/actueel_beeld.xml.gz` after gunzip. NDW wrote it at 2026-11-25 01:12:00 UTC.
- The full file had 3.5 MB of XML. The fixture keeps its envelope and the first situation of six different classes. Each situation is real text with no change.
- The fixture holds 8 situation records. Each record has the status `definedByValidityTimeSpec` and is valid at the time of the publication.
- The records of the fixture are 2 closures, 1 vehicle obstruction and 5 records of the group `other`: lane management, speed management and the swing of a bridge.
- The publication time has nine digits of a second: `2026-11-25T01:12:00.002329901Z`.
- The open data of NDW is under the license CC0 1.0. The records are facts about roads. They contain no personal data.
