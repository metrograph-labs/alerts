# The fixtures of the OSV source

The research of 2026-11-25 read each fixture with the `User-Agent` `alerts-atlas-research/1.0`.

- `MAL-2026-20607.json` comes from `https://osv-vulnerabilities.storage.googleapis.com/npm/MAL-2026-20607.json`. It is a record of a malicious npm package. The fixture has no `credits` and fewer `indicators` than the real record.
- `MAL-2026-5587.json` comes from the folder `osv/withdrawn` of the repository `ossf/malicious-packages`. The record was withdrawn at 2026-07-16 00:38:53 UTC. The fixture has a cut `details` text, one reference and no `credits`.
- `GHSA-crj3-q72p-ggqm.json` comes from the npm exports. It is an advisory with a CVE alias and a `SEMVER` range, not a `MAL-` record. The fixture has a cut `details` text and no `credits`.
- `npm-modified_id.csv` holds the first 40 lines of `https://osv-vulnerabilities.storage.googleapis.com/npm/modified_id.csv`. The full list had 233,135 lines and 8.8 MB.
- `commits.json` holds the newest commit of `https://api.github.com/repos/ossf/malicious-packages/commits?sha=main&per_page=1`. The fixture keeps only the id, the time and the first line of the message.
- `compare.json` holds a compare of the repository for four commits. The fixture keeps only the status, the counts, the ids, the times, the first lines of the messages and the files.

The fixtures contain no name, no email address and no account of a person. The records are under the license Apache-2.0 (`https://github.com/ossf/malicious-packages/blob/main/LICENSE`). The advisory comes from the GitHub Advisory Database under the license CC BY 4.0.
