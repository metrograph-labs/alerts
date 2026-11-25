# The fixtures of the Digitraffic rail source

- `rail-20261125T1331Z.json` holds a real answer of the GraphQL query of the source, with the departure date 2026-11-25. The fetch was at 2026-11-25 13:31:19 UTC.
- The full answer had 38 kB: 134 running trains and 396 cancelled trains of all categories.
- The fixture keeps 9 running trains and 6 cancelled trains of the answer, with no change to a train.
- The running trains of the fixture are 3 commuter trains, 3 long-distance trains, 2 freight trains and 1 shunting move. 1 commuter train and 2 long-distance trains are 5 minutes late or more at their last stop.
- The cancelled trains of the fixture are 3 commuter trains, 1 long-distance train and 2 freight trains.
- The newest actual time of the fixture is 2026-11-25 13:32:43 UTC, 84 seconds after the time of the fetch on the clock of the computer.
- The rail data of Digitraffic is under the license CC BY 4.0: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY". The answer holds only the category, the delay and the actual time of each train. It contains no personal data.
