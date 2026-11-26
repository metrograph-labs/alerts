/**
 * The local page. It reads the map from the alert runtime on this computer every 30 seconds, and when the page
 * comes back into view. It draws the map, the list of the incidents and the region codes with no shape.
 * The map is a globe that a person can move. A browser with no WebGL 2 gets the flat map.
 *
 * A time scrubber below the map sets the time of the page. Its end is the present, and each other time is from the
 * history of the runtime. The page sends each request to the origin of the page only.
 *
 * A panel below the map tells the health of each source, and if a quota or a balance stops a message. A link at the
 * top of the page has the same two sentences. The health is of the present, also when the map shows a past time.
 *
 * A panel tells the dimensions of the indicators out of their normal level, in the world and near each place.
 * The indicators are of the present too.
 *
 * The next panel tells each pair where the table of the levels and the shadow score disagree. The score is of the present.
 *
 * A failed read of the map shows the shared error view of `@mark1russell7/otel-ts/error-view`. The view has the words of
 * the failure, a retry, a copy of the whole record and a report. The view of the same failure stays, with its record and
 * its time.
 *
 * The last panel tells the interest graph of each person: each edge, its origin, its weight and its state. A default
 * edge that an edge of the person replaces stays as a row. The graph changes only with the configuration. Thus the page
 * reads it with the whole history.
 */

import { NO_HISTORIES, type Histories, type MapPayload } from "@mark1russell7/alerts";
import { errorView } from "@mark1russell7/otel-ts/error-view";
import { byId, setupTheme } from "@mark1russell7/site-pages/chrome";
import { replayOf, replayPause, replaySeek, replaySpan, type Replay } from "@mark1russell7/visuals";
import { createScrubber, type Scrubber } from "@mark1russell7/visuals/scrubber";
import { loadGlobe } from "./globe-load.ts";
import { readHealth, type HealthRead } from "./health-read.ts";
import { drawHealth, drawVerdicts, healthPanel, keepHealth, NO_HEALTH, type KeptHealth } from "./health-view.ts";
import { readHistories, WHOLE_READ_EVERY_MS } from "./history-read.ts";
import { drawIndicators, indicatorPanel } from "./indicators-view.ts";
import { readInterests } from "./interests-read.ts";
import { drawInterests, interestPanel } from "./interests-view.ts";
import { MAP_PATH, readLine, readMap, READ_EVERY_MS } from "./map-read.ts";
import { drawIncidentList, drawMapView, drawStatusLegend, drawUnshaped } from "./map-view.ts";
import { READ_ERROR_SUMMARY, readErrorRecord, reportAddress } from "./read-error.ts";
import { differencePanel, drawDifferences } from "./score-view.ts";
import { scrubKey, scrubLabels, scrubPayload, scrubRange, scrubText, scrubWords, timeForm, type ScrubRange, type TimeForm } from "./scrub.ts";

setupTheme(byId<HTMLButtonElement>("theme"), "theme");

const mapBox = byId("map");
const list = byId("incidents");
const legend = byId("legend");
const unshaped = byId("unshaped");
const problem = byId("problem");
const line = byId("read");
const mapTitle = byId("map-h");
const listTitle = byId("incidents-h");
const timeBox = byId("time");
const timeProblem = byId("time-problem");
const past = byId("past");
const pastText = byId("past-text");
const brief = byId("brief");
const healthTitle = byId("sources-h");
const healthPast = byId("health-past");
const healthSum = byId("health-sum");
const healthProblem = byId("health-problem");
const healthBox = byId("health");
const healthHint = byId("health-hint");
const indicatorSum = byId("indicator-sum");
const indicatorBox = byId("indicators");
const scoreSum = byId("score-sum");
const differenceBox = byId("differences");
const interestSum = byId("interest-sum");
const interestBox = byId("interests");

/** The live map: the last good read of the runtime. */
let payload: MapPayload | undefined;
/** The map of the picture: the live map, or the map of the time of the scrubber. */
let picture: MapPayload | undefined;
/** The histories of the incidents, from the reads of the history. */
let kept: Histories = NO_HISTORIES;
/** The range of the scrubber. The page shows no scrubber with no range. */
let range: ScrubRange | undefined;
let scrubber: Scrubber | undefined;
/** The key of the picture. A time with the same key has the same picture. */
let drawn = -1;
/** The time of the last read of the whole history. */
let wholeAt = -Infinity;
let selected: string | undefined;
let lastGood: number | undefined;
let reading = false;
/** The health of the sources that the page keeps between two reads. */
let health: KeptHealth = NO_HEALTH;
/** The sentences of the panel of the sources that the page shows. The page writes them again only when they change. */
let verdicts = "";
/** The data of the panel of the indicators that the page shows. The page writes the panel again only when it changes. */
let indicators = "";
/** The data of the panel of the shadow score that the page shows. The page writes the panel again only when it changes. */
let differences = "";
/** The data of the panel of the interests that the page shows. The page writes the panel again only when it changes. */
let interests = "";
/** This value is true after one read of the interests with an answer. A failed read starts again at the next refresh. */
let interestsKnown = false;

const time = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const FORMS: Readonly<Record<TimeForm, Intl.DateTimeFormatOptions>> = {
  time: { hour: "2-digit", minute: "2-digit" },
  weekday: { weekday: "short", hour: "2-digit", minute: "2-digit" },
  date: { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
};
const day = (at: number): string => new Date(at).toDateString();
/** This function gives the text of a past time for a reader at the present. A time of a different day has its day. */
const clock = (at: number, present: number): string => new Date(at).toLocaleString(undefined, FORMS[timeForm(at, present, day)]);

// A pick on the globe selects its incident. The camera stays, because the person looks at the incident.
// The draw also puts the mark of the selection on the incident, when the pick was a place or a region.
// The code of the globe is a file of the site. It comes after the first picture of the page, and then the page draws again.
const globe = loadGlobe(
  { box: byId("globe"), tools: byId("globe-tools"), words: byId("words"), whole: byId<HTMLButtonElement>("whole") },
  (anchor) => {
    selected = anchor;
    draw(false);
  },
  {},
  () => {
    draw(false);
  },
);

/** This function selects an incident of the list or of the flat map. A second selection of the incident removes the selection. */
function select(anchor: string): void {
  // A focused incident keeps the focus after the new draw, in the same part of the page.
  const box = document.activeElement?.closest("#map, #incidents");
  selected = selected === anchor ? undefined : anchor;
  draw(true);
  if (box instanceof HTMLElement) box.querySelector<HTMLElement | SVGElement>(`[data-anchor="${CSS.escape(anchor)}"]`)?.focus();
}

/** This function draws the page. With `move`, the camera of the globe goes to the selected incident. */
function draw(move: boolean): void {
  if (picture === undefined) return;
  const view = picture.view;
  if (selected !== undefined && !view.incidents.some((incident) => incident.anchor === selected)) selected = undefined;
  // The globe shows the payload when it can. If not, the flat map shows it.
  const onGlobe = globe.show(picture, selected, move);
  mapBox.hidden = onGlobe;
  mapBox.replaceChildren(...(onGlobe ? [] : [drawMapView(view, { basemap: picture.basemap, ...(selected === undefined ? {} : { selected }), select })]));
  // The legend names each status other than actual that the map shows.
  drawStatusLegend(legend, view);
  list.replaceChildren(drawIncidentList(view, selected, select));
  const codes = drawUnshaped(view);
  unshaped.replaceChildren(...(codes === null ? [] : [codes]));
}

/** This function writes the words of the time of the map: the two headings, and the note of a past time. */
function setWords(replay: Replay | undefined): void {
  const words = scrubWords(replay, clock);
  // A replay starts this function for each picture of the browser. The page changes only when a text is new.
  if (mapTitle.textContent !== words.map) mapTitle.textContent = words.map;
  if (listTitle.textContent !== words.list) listTitle.textContent = words.list;
  if (words.past !== undefined && pastText.textContent !== words.past) pastText.textContent = words.past;
  past.hidden = words.past === undefined;
  // The health is of the present only. For a past time, the panel of the sources tells that it stays at the present.
  if (healthTitle.textContent !== words.sources) healthTitle.textContent = words.sources;
  if (words.health !== undefined && healthPast.textContent !== words.health) healthPast.textContent = words.health;
  healthPast.hidden = words.health === undefined;
}

/**
 * This function shows the result of a read of the health in the panel of the sources and in the link at the top.
 * With no result, the runtime did not answer the read of the map, and the page did not ask for the health.
 */
function showHealth(result: HealthRead | undefined): void {
  const at = Date.now();
  health = keepHealth(health, result, at);
  const panel = healthPanel(health, at, clock);
  // A screen reader reads the sentences when they change. Thus a read with the same sentences does not write them again.
  const key = JSON.stringify(panel.verdicts);
  if (key !== verdicts) {
    verdicts = key;
    healthSum.replaceChildren(...drawVerdicts(panel.verdicts, "p"));
    brief.replaceChildren(...drawVerdicts(panel.verdicts, "span"));
  }
  healthProblem.textContent = panel.problem ?? "";
  healthProblem.hidden = panel.problem === undefined;
  healthBox.replaceChildren(...drawHealth(panel));
  // The hint tells the sequence of the rows. A panel with no row does not show it.
  healthHint.hidden = panel.rows.length === 0;
}

/** This function writes the panel of the indicators from the live map. The panel is of the present, as the health is. */
function showIndicators(live: MapPayload): void {
  const panel = indicatorPanel(live.breadth, live.view.places);
  const key = JSON.stringify(panel);
  if (key === indicators) return;
  indicators = key;
  indicatorSum.replaceChildren(...drawVerdicts([panel.verdict], "p"));
  indicatorBox.replaceChildren(...drawIndicators(panel));
}

/** This function writes the panel of the shadow score from the live map. The history has no score, so the panel is of the present. */
function showDifferences(live: MapPayload): void {
  const panel = differencePanel(live.view);
  const key = JSON.stringify(panel);
  if (key === differences) return;
  differences = key;
  scoreSum.replaceChildren(...drawVerdicts([panel.verdict], "p"));
  differenceBox.replaceChildren(...drawDifferences(panel));
}

/** This function writes the panel of the interests from one read of the runtime. */
async function showInterests(get: (path: string) => Promise<Response>): Promise<void> {
  const read = await readInterests(get);
  interestsKnown = read.ok || read.absent;
  const panel = interestPanel(read);
  const key = JSON.stringify(panel);
  if (key === interests) return;
  interests = key;
  interestSum.replaceChildren(...drawVerdicts([panel.verdict], "p"));
  interestBox.replaceChildren(...drawInterests(panel));
}

/** This function sets the map of the picture from the live map and the time of the scrubber. */
function setPicture(): void {
  const replay = scrubber?.replay();
  picture = payload === undefined ? undefined : scrubPayload(payload, kept, replay);
  drawn = scrubKey(replay, range?.times ?? []);
  setWords(replay);
}

/** This function gives the scrubber the range of the last read. With no range, the page has no scrubber and shows the present. */
function setRange(absent: boolean): void {
  range = payload === undefined || absent ? undefined : scrubRange(payload, kept);
  timeBox.hidden = range === undefined;
  if (range === undefined) {
    scrubber?.dispose();
    scrubber = undefined;
    return;
  }
  const labels = scrubLabels(range.span, clock);
  if (scrubber === undefined) {
    scrubber = createScrubber(timeBox, {
      label: "Time of the map",
      replay: replayOf(range.span),
      times: range.times,
      labels,
      format: (at, replay) => scrubText(at, replay, clock),
      onChange: (replay) => {
        setWords(replay);
        if (scrubKey(replay, range?.times ?? []) === drawn) return;
        setPicture();
        draw(false);
      },
    });
    return;
  }
  // A scrubber at the present stays at the present. A past time stays the same time.
  scrubber.setReplay(replaySpan(scrubber.replay(), range.span));
  scrubber.setTimes(range.times);
  scrubber.setLabels(labels);
}

byId<HTMLButtonElement>("now").addEventListener("click", () => {
  if (scrubber === undefined) return;
  const replay = scrubber.replay();
  scrubber.setReplay(replayPause(replaySeek(replay, replay.span.to)));
  setPicture();
  draw(false);
  // The button leaves the page with its note. The keyboard goes to the slider of the scrubber.
  scrubber.element.querySelector<HTMLElement>('input[type="range"]')?.focus();
});

/** The words of the failure that the error view shows, or undefined after a good read. */
let shownProblem: string | undefined;

/**
 * This function shows the error view of a failed read of the map, or removes it after a good read. A failure with the
 * same words keeps the view. Thus an open list of details stays open after the next read.
 */
function showProblem(text: string | undefined): void {
  problem.hidden = text === undefined;
  if (text === shownProblem) return;
  shownProblem = text;
  if (text === undefined) {
    problem.replaceChildren();
    return;
  }
  const view = errorView(readErrorRecord({ text, path: MAP_PATH, page: location.pathname }), { retry: true, report: "Report", summary: READ_ERROR_SUMMARY });
  view.addEventListener("otel-error-retry", (event) => event.detail.waitUntil(refresh()));
  view.addEventListener("otel-error-report", (event) => {
    window.open(reportAddress(event.detail.record), "_blank", "noopener");
  });
  problem.replaceChildren(view);
}

async function refresh(): Promise<void> {
  if (reading || document.hidden) return;
  reading = true;
  try {
    const get = (path: string): Promise<Response> => fetch(path, { cache: "no-store", credentials: "same-origin" });
    const result = await readMap(get);
    if (result.ok) {
      payload = result.payload;
      lastGood = Date.now();
      showIndicators(result.payload);
      showDifferences(result.payload);
      // The history comes after a good map. Thus a runtime that does not answer gets one request, and the page tells one problem.
      const whole = lastGood - wholeAt >= WHOLE_READ_EVERY_MS;
      const histories = await readHistories(get, kept, whole);
      kept = histories.kept;
      if (whole && histories.text === undefined) wholeAt = lastGood;
      // The interests change only with the configuration. Thus the page reads them with the whole history.
      if (whole || !interestsKnown) await showInterests(get);
      timeProblem.textContent = histories.text ?? "";
      timeProblem.hidden = histories.text === undefined;
      setRange(histories.absent);
      setPicture();
      draw(false);
    }
    showProblem(result.ok ? undefined : result.text);
    line.textContent = readLine(lastGood, !result.ok, time);
    // The health also comes after a good map, for the same reason. It is the last read, so a slow health does not hold the map.
    showHealth(result.ok ? await readHealth(get) : undefined);
  } finally {
    reading = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
setInterval(() => void refresh(), READ_EVERY_MS);
void refresh();
