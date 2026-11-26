# @mark1russell7/alerts-source-osv

The source adapter of the alert system for records in the OSV format (`https://ossf.github.io/osv-schema/`). The first records are the `MAL-` records of the OpenSSF repository of malicious packages. Each record names packages in a public registry that contain malware.

## The parts

| Part | What it does |
| --- | --- |
| `readOsv`, `readOsvText` | They read one record and check it against the schema. A bad field gives its path. The reader keeps no credits. |
| `OSV_PROVIDERS` | The two feeds as data rows. A new feed of the same form is a new row. |
| `createOsvFetch` | It reads the changed records of one feed, at most `RECORDS_PER_FETCH` in one fetch. |
| `createOsvMap` | It gives one report of the kind `cyber.supply-chain.malicious-package` for each record. |
| `checkCanary` | It fails when the newest change of the feed is older than 2 days. |
| `createOsvSource` | It gives the procedures of one source: describe, fetch, map and check. |

## The two feeds

| Source | Feed | How a fetch reads it |
| --- | --- | --- |
| `osv-export-malicious` | The data exports of OSV.dev on Google Cloud Storage | The fetch reads the first 64 KiB of `<ecosystem>/modified_id.csv` with a `Range` header and an `ETag`. The list starts with the newest change. The fetch reads `<ecosystem>/<id>.json` only for the new `MAL-` lines after its cursor. |
| `ossf-malicious-packages` | The repository `ossf/malicious-packages` on GitHub | The fetch compares the last read commit with the branch through the GitHub API, with no token. It reads each added or changed record file through `raw.githubusercontent.com`. |

The two sources have one origin, `ossf`. Thus the merge counts their reports of one record as copies, not as two authorities. The two feeds have different paths: Google Cloud and GitHub.

- The GitHub API gives 60 requests in each hour to an address with no token. The source sends 1 conditional request in each hour.
- The first fetch of the exports reads only the changes of the last day. The first fetch of the repository reads no record.
- A record file that the host does not find is passed. A 403, a 429 or another failure stops the fetch, and the next fetch reads that record again.

## The report

- The subject of a report is each package as a purl with no version, for example `pkg:npm/%40scope/name`. A CVE alias is also a subject.
- The id of the record and each alias are correlation keys.
- A report is `severe`, `immediate` and `likely`, with the response `avoid`. It ends 30 days after the last change of the record.
- A change of a record one day or more after its publication gives an update.
- A withdrawn record gives a cancel. A cancel is not live at any time. Thus it gives no alert, and it ends the earlier report of the record.
- An ecosystem with no purl type, for example `VSCode`, gives a report with no subject of its package, and a note.

## The quiet start

The runtime starts each new source in the observe mode (AL-73), behind the send limit of each person (AL-72). In this mode, the reports of the source go to the record, and only a life-safety level goes to a person. The observe mode records the rate per hour and the share that matches each person. The package adds no copy of this guard.

## Terms

The records of the repository are under the license Apache-2.0 (`https://github.com/ossf/malicious-packages/blob/main/LICENSE`). Each report has the terms in its parameters.
