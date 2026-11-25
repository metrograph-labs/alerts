# The fixtures of the GFZ source

- `kp-20261117T0233Z.json` holds the real bytes of the answer to `https://kp.gfz.de/app/json/?start=2026-11-14T00:00:00Z&end=2026-11-17T02:59:59Z&index=Kp`. The site sent it at 2026-11-17 02:33:04 UTC.
- The answer has 25 values of Kp, from the interval of 2026-11-14 00:00 UTC to the interval of 2026-11-17 00:00 UTC. The largest value is 1.667, so no value is G1 or more. Each status is `pre`.
- The last interval had not ended. The answer gives a value for it, so the value of the current interval comes during the interval.
- `kp-20240510-20240512.json` holds the real bytes of the answer to `https://kp.gfz.de/app/json/?start=2024-05-10T00:00:00Z&end=2024-05-12T23:59:59Z&index=Kp`. The site sent it at 2026-11-17 02:33:04 UTC.
- These are the 24 intervals of the G5 storm of 10 to 12 May 2024. The values go up to 9, and each status is `def`.
- `kp-20240829-20240831.json` holds the real bytes of the answer to `https://kp.gfz.de/app/json/?start=2024-08-29T00:00:00Z&end=2024-08-31T23:59:59Z&index=Kp`. The site sent it at 2026-11-18 02:29:35 UTC.
- It has 24 intervals, and each status is `def`. The intervals of G1 are 2024-08-30 12:00 to 21:00 UTC and 2024-08-31 15:00 to 18:00 UTC, each at Kp 5-.
- `kp-20250529-20250531.json` holds the real bytes of the answer to `https://kp.gfz.de/app/json/?start=2025-05-29T00:00:00Z&end=2025-05-31T23:59:59Z&index=Kp`. The site sent it at 2026-11-18 02:29:36 UTC.
- It has 24 intervals, and each status is `def`. Each interval of 29 May 2025 is G1 or more, up to Kp 6+. The interval of 2025-05-30 15:00 UTC is a run of one interval.
- The link gate (`src/link.test.ts`) reads these two answers with the messages of the SWPC of the same days. The window of the link decides each of their runs.
- Each answer ends with `]}` and a line break. The answers had `Content-Type: application/json` and no `ETag` and no `Last-Modified`.
- The answers give the license in the field `meta.license`: `CC BY 4.0`. The credit that GFZ asks for is "GFZ German Research Centre for Geosciences".
- The values are measures of the magnetic field of the Earth. They contain no personal data.

## The fixtures of the index Hp30

- `hp30-20261125T1422Z.json` holds the real bytes of the answer to `https://kp.gfz.de/app/json/?start=2026-11-22T14:00:00Z&end=2026-11-25T14:29:59Z&index=Hp30`. The site sent it at 2026-11-25 14:22 UTC.
- The answer has 144 values of Hp30, from 2026-11-22 14:00 UTC to 2026-11-25 13:30 UTC. The largest value is 3.333, so no value is G1 or more.
- The answer had no value for the current interval of 14:00 UTC. Thus the value of an interval of Hp30 can come after the end of the interval.
- `hp30-20240510-20240512.json` holds the real bytes of the answer to `https://kp.gfz.de/app/json/?start=2024-05-10T00:00:00Z&end=2024-05-12T23:59:59Z&index=Hp30`. The site sent it on 2026-11-25.
- These are the 144 intervals of the G5 storm of 10 to 12 May 2024. The largest value is 11.333 (11+), at 2024-05-10 22:30 UTC. 19 values are above 9.
- An answer of Hp30 has the columns `datetime` and `Hp30` and the field `meta`, with the license `CC BY 4.0`. It has no column `status`.
