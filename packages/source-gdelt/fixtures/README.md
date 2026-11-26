# The fixtures of the GDELT source

- `events-20261123200000.tsv` comes from the real event file `https://data.gdeltproject.org/gdeltv2/20261123200000.export.CSV.zip`. The fixture holds the file that the archive contains, not the archive.
- The real file had 958 events. The fixture keeps 5 lines with no change, in the order of the file.
- Three lines give a report: a riot in Dhaka (`145`), fighting in Port-au-Prince (`190`) and fighting with small arms in Gaza (`193`).
- Two lines give no report: an event with the root code `03`, and a fight with the place of a country only (`195`).
- The machine of GDELT coded these events from the news. Some codes are wrong: the line of Dhaka comes from an article about bad loans. The tests keep these lines because a real feed has this noise.
- The data is from the GDELT Project (`https://www.gdeltproject.org/`). The terms permit use and redistribution with a citation and a link.
- The lines name countries, cities, groups and news pages. They contain no personal data.
- `20261123200000.export.CSV.zip` is an archive of the same 5 lines, with the method deflate, as GDELT gives. A ZIP tool made it from the `.tsv` file. The tests of the runtime use it as the answer of GDELT.
