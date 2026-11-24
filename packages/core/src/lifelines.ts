/**
 * The lifelines of a community and the needs of a person under them (AL-106).
 *
 * The lifelines are the 8 FEMA Community Lifelines. The source is the FEMA Community Lifelines
 * Implementation Toolkit, version 2.1 (2023), with the FEMA page of the lifelines (last update 2024-03-08).
 * Version 2.1 added Water Systems as the 8th lifeline, and it changed the name "Food, Water, Shelter" to
 * "Food, Hydration, Shelter".
 *
 * A need is a thing that a person uses each day, for example water to drink. Each need has a lifeline, a
 * level, a unit and an amount for each person each day. The module names no person, no household and no
 * place. The people and their amounts are input data.
 *
 * The file `lifelines.lock.json` holds each code of a lifeline and each code of a need. A test holds the
 * lock, thus the removal of a code is a deliberate step.
 */

import type { Level } from "./contracts.ts";

/** The page of FEMA that gives the names of the lifelines. */
export const LIFELINES_SOURCE = "https://www.fema.gov/emergency-managers/practitioners/lifelines";

/** The toolkit of FEMA that added the 8th lifeline: version 2.1, 2023. */
export const LIFELINES_TOOLKIT = "https://www.fema.gov/sites/default/files/documents/fema_lifelines-toolkit-v2.1_2023.pdf";

/** The codes of the 8 FEMA Community Lifelines, in the order of FEMA. */
export const LIFELINES = ["safety", "food-hydration-shelter", "health", "energy", "communications", "transportation", "hazmat", "water"] as const;

/** The code of one FEMA Community Lifeline. */
export type Lifeline = (typeof LIFELINES)[number];

/** The name of each lifeline, as FEMA writes it. */
export const LIFELINE_LABELS: Readonly<Record<Lifeline, string>> = {
  safety: "Safety and Security",
  "food-hydration-shelter": "Food, Hydration, Shelter",
  health: "Health and Medical",
  energy: "Energy",
  communications: "Communications",
  transportation: "Transportation",
  hazmat: "Hazardous Materials",
  water: "Water Systems",
};

/** This function tells if a text is the code of a lifeline. */
export function isLifeline(code: string): code is Lifeline {
  return (LIFELINES as readonly string[]).includes(code);
}

/**
 * The levels of a need, from the most serious. A `life` need keeps a person alive. A `health` need keeps
 * a person well. A `comfort` need makes the time easier.
 */
export const NEED_LEVELS = ["life", "health", "comfort"] as const;

/** The level of one need. */
export type NeedLevel = (typeof NEED_LEVELS)[number];

/** The level of an alert when a need of each level is at risk. */
export const NEED_ALERT_LEVELS: Readonly<Record<NeedLevel, Level>> = {
  life: "life-safety",
  health: "urgent",
  comfort: "notice",
};

/** A dotted code of a need in lower case, for example `hydration.drink` or `food.energy`. */
export type NeedCode = string;

/** A need: a thing that a person uses each day. */
export interface Need {
  readonly code: NeedCode;
  readonly lifeline: Lifeline;
  readonly level: NeedLevel;
  /** The unit of the amount, in the grammar of `@mark1russell7/quantity`, for example `L`, `kcal`, `Wh` or `{dose}`. */
  readonly unit: string;
  /** The default amount for each person each day, in `unit`. A person can have a different amount. */
  readonly perPersonDay: number;
}

/** The source of a default amount: the title of a page, its URL and the date that the page gives. */
export interface NeedSource {
  readonly title: string;
  readonly url: string;
  /** The date of the page, `YYYY-MM-DD`: its last update or the date that its content is current. */
  readonly date: string;
}

/** A need with the source of its default amount. */
export interface CitedNeed extends Need {
  readonly source: NeedSource;
  /** What the amount includes, when the source tells it. */
  readonly note?: string;
}

/** The volume of one US gallon in litres. The definition is exactly 231 cubic inches. */
export const US_GALLON_L = 3.785411784;

/**
 * The needs with a default amount from an official source. A need with no such source is not in the list.
 * A user gives it as input data.
 */
export const NEEDS: readonly CitedNeed[] = [
  {
    code: "hydration.drink",
    lifeline: "food-hydration-shelter",
    level: "life",
    unit: "L",
    perPersonDay: US_GALLON_L,
    source: { title: "Ready.gov: Water", url: "https://www.ready.gov/water", date: "2021-02-22" },
    note: "The amount of Ready.gov is at least one gallon for each person each day, for drinking and sanitation.",
  },
  {
    code: "food.infant-formula",
    lifeline: "food-hydration-shelter",
    level: "life",
    unit: "kcal",
    perPersonDay: 589,
    source: { title: "National Academies: Dietary Reference Intakes for Energy (2023)", url: "https://nap.nationalacademies.org/26818", date: "2023-03-28" },
    note: "The amount is the largest Estimated Energy Requirement below 6 months: boys of 3 to 5 months, Table 7-5. Below 6 months, formula is the only food of an infant with no breast milk.",
  },
  {
    code: "food.energy",
    lifeline: "food-hydration-shelter",
    level: "health",
    unit: "kcal",
    perPersonDay: 2000,
    source: { title: "FDA: How to Understand and Use the Nutrition Facts Label", url: "https://www.fda.gov/food/nutrition-facts-label/how-understand-and-use-nutrition-facts-label", date: "2024-03-05" },
    note: "The FDA uses 2,000 calories each day as a general guide for nutrition advice. A person can need more or less.",
  },
];

const NEED_CODE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** This function tells if a text has the form of a code of a need: two or more dotted parts in lower case. */
export function isNeedCode(code: string): boolean {
  return NEED_CODE.test(code);
}
