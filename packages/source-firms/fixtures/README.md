# The fixtures of the FIRMS source

- `viirs-noaa21-area.csv` holds 7 real rows of one answer of the area API of FIRMS. The API sent the answer on 2026-11-26 at about 13:50 UTC.
- The query asked for the product `VIIRS_NOAA21_NRT` in the box `15,5,25,10` for 2 days. The answer had 3008 rows.
- The fixture keeps the header and the 5 rows of one fire near 8.54 N, 24.75 E. It also keeps 2 rows from far away.
- The 5 rows of the fire are 2 rows of the high confidence, 2 rows of the nominal confidence and 1 row of the low confidence.
- `availability.csv` holds the real bytes of the answer of the dates of the data at 2026-11-26 13:46 UTC.
- In that answer, the newest data of `VIIRS_SNPP_NRT` is of 2026-11-02. The newest data of `VIIRS_NOAA20_NRT` and `VIIRS_NOAA21_NRT` is of 2026-11-26.
- The source sends the key in the path of each URL. The URLs below have the text `<key>` in place of the key.

```text
https://firms.modaps.eosdis.nasa.gov/api/area/csv/<key>/VIIRS_NOAA21_NRT/15,5,25,10/2
https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/<key>/ALL
```

## What the answers show

- An answer with no hotspot has only the header line.
- A key that FIRMS does not accept gives the status 400 and the text `Invalid MAP_KEY.`.
- The field `acq_time` is the time of the scan in UTC as `HHMM`, with no zero at the start. The value `15` is 00:15 UTC.
- The field `confidence` of a VIIRS row is `l`, `n` or `h`: low, nominal or high.

## Terms

The data of NASA FIRMS comes from missions of NASA and NOAA. The data use guidance of NASA Earthdata gives it with no restriction (CC0 1.0). NASA asks for a citation of FIRMS in each use of the data.
