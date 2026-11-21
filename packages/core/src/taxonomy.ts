/**
 * The taxonomy of the kinds. A kind code is dotted, for example `met.flood.flash`. Its first part is a
 * category of the system. The taxonomy is a tree: the parent of each code is also a code, so
 * `met.flood` is the parent of `met.flood.flash`. Each category is a root. `parentKind` gives the parent.
 *
 * The taxonomy is closed. Each code that a map function gives must be in it, and a gate test of each
 * adapter holds this rule. A code with a typo does not match the life-safety class, so it can stop a
 * wake. The schemas of the private configuration hold the same rule for each kind that a person names.
 *
 * The source atlas (`@mark1russell7/alerts-atlas`) uses these codes as its signal classes. Each code has
 * its plain name and its summary here, and in no other place. A new code comes here first, in its pull request.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import { BALANCE_KIND, CHANNEL_KIND, CLOCK_KIND, COPY_KIND, COVERAGE_KIND, DRILL_KIND, ESCALATION_KIND, HEALTH_KIND, LIMIT_KIND, LOG_KIND, QUOTA_KIND, STORE_KIND, TELL_KIND } from "./assess.ts";
import type { BalanceStage, Category, CopyStage, HealthState, QuotaStage } from "./contracts.ts";

/** One code of the taxonomy: its plain name and one plain sentence about it. */
export interface KindEntry {
  /** The plain name, for example `Flash flood`. */
  readonly label: string;
  /** One plain sentence that tells what a signal of the code is. */
  readonly summary: string;
}

const entry = (label: string, summary: string): KindEntry => ({ label, summary });

// The categories of the system: the 12 categories of CAP 1.2 first, then the categories that CAP does not have.
const CATEGORY_ENTRIES: Readonly<Record<Category, KindEntry>> = {
  geo: entry("Geophysical", "A hazard from the solid Earth or from space: earthquakes, volcanoes, tsunamis, landslides and space weather."),
  met: entry("Weather", "A hazard from the weather, the water or the sea, with the products of a weather service."),
  safety: entry("Public safety", "A general emergency or a danger to the public, from an evacuation to a product recall."),
  security: entry("Security", "A threat from people: law enforcement, armed conflict, terrorism and crime."),
  rescue: entry("Rescue", "Rescue and recovery: search and rescue, shelters and aid after a disaster."),
  fire: entry("Fire", "A fire or a fire danger: wildfires, fire weather, burn bans and structure fires."),
  health: entry("Health", "A danger to health: outbreaks, the drug supply and the capacity of hospitals."),
  env: entry("Environment", "A danger from pollution or from nature: air quality, smoke, water quality, pollen and UV."),
  transport: entry("Transport", "A disruption or an accident of air, rail, road, sea, space or public transport."),
  infra: entry("Infrastructure", "A failure of a utility or a service that people depend on: power, water, telecom, internet and supply."),
  cbrne: entry("Chemical, biological, radiological and nuclear", "A release of a chemical, biological, radiological or nuclear agent, or an explosion."),
  other: entry("Other", "A signal that no other category holds, for example an event that the kind tables do not know."),
  cyber: entry("Cyber", "A cyber threat: an exploited flaw, an attack, a breach or a malicious package."),
  market: entry("Markets", "A move or a failure in finance: banks, exchanges, prices, crypto and prediction markets."),
  civic: entry("Civic", "An action of a government or a public body: declarations, rules, elections, closures and holidays."),
  personal: entry("Personal", "A change in the life of one person or one household, for example a loss of income or a death."),
  system: entry("The alert system", "A message of the alert system about itself: the health of a source, coverage, quota and tests."),
};

/** The plain name of each category of the system. Each category is also the root code of a tree. */
export const CATEGORY_LABELS: Readonly<Record<Category, string>> = Object.fromEntries(
  Object.entries(CATEGORY_ENTRIES).map(([category, value]) => [category, value.label]),
) as Record<Category, string>;

/** The categories of the system: the 12 categories of CAP 1.2 first, then the categories that CAP does not have. */
export const CATEGORIES: readonly Category[] = Object.keys(CATEGORY_ENTRIES) as Category[];

/** This function gives the category of a kind code: its first part. A first part that is not a category gives `other`. */
export function categoryOf(kindCode: string): Category {
  const first = kindCode.split(".", 1)[0] ?? "";
  return Object.hasOwn(CATEGORY_ENTRIES, first) ? (first as Category) : "other";
}

/** The code of a kind that the tables of an adapter do not know. */
export const UNKNOWN_KIND = "other.unknown";

// The quota kinds of the core: one for each stage of the quota of a channel.
const QUOTA_ENTRIES: Readonly<Record<QuotaStage, KindEntry>> = {
  low: entry("Low quota of a channel", "The window of a channel has 2 reserves of units or fewer left."),
  reserve: entry("Quota of a channel in its reserve", "The window of a channel has its reserve or fewer units left, so the channel sends only life-safety messages."),
  spent: entry("Spent quota of a channel", "The provider of a channel refuses each message, also a life-safety message."),
};

// The balance kinds of the core: one for each stage of the balance of a provider account.
const BALANCE_ENTRIES: Readonly<Record<BalanceStage, KindEntry>> = {
  low: entry("Low balance of a provider", "The balance of a paid provider account is below its floor."),
  empty: entry("Empty balance of a provider", "The balance of a paid provider account is 0 or less, so the provider refuses each paid message."),
  unread: entry("Balance of a provider not read", "No read of the balance of a paid provider account passed for the maximum age, so a low balance is not seen."),
};

// The copy kinds of the core: one for each stage of the watch of another copy of the system.
const COPY_ENTRIES: Readonly<Record<CopyStage, KindEntry>> = {
  skew: entry("Clock difference of a copy", "The clock of another copy of the alert system differs from the clock of this copy by more than the limit."),
  config: entry("Configuration difference of a copy", "Another copy of the alert system has a different configuration, so the copies can route an alert in two ways."),
  unread: entry("Copy not read", "No read of the log of another copy of the alert system passed for the maximum age, so the two copies can both send."),
  unsteady: entry("Copy not steady", "Another copy of the alert system starts again and again and does not get steady, so it sends no alert."),
};

// The health kinds of the core: one for each health state, and `late` for the lateness against another source.
const HEALTH_ENTRIES: Readonly<Record<HealthState | "late", KindEntry>> = {
  unknown: entry("Health of a source not known", "The system has no fetch of the source yet, so it does not know its health."),
  healthy: entry("Healthy source", "The source answers on time with valid signals."),
  slow: entry("Slow source", "The source answers, but slower than its usual time."),
  failing: entry("Failing source", "The fetches or the canary of the source fail."),
  silent: entry("Silent source", "The source gives no fresh observation for longer than its quiet limit, and quiet is not normal for it."),
  changed: entry("Changed format of a source", "A fetch passed, but the map found fatal or lossy problems: the format of the source changed."),
  late: entry("Late source", "The source gives a signal later than another source of the same event."),
};

/**
 * The codes of the taxonomy, each with its plain name and its summary. The categories come first, then
 * the codes of each category. The kinds of the core come last. The coverage codes `system.coverage.<code>`
 * are a family: `knownKind` finds them.
 */
export const TAXONOMY: Readonly<Record<string, KindEntry>> = {
  ...CATEGORY_ENTRIES,

  "geo.avalanche": entry("Avalanche", "Snow avalanche danger for backcountry zones, and avalanche warnings for roads and towns."),
  "geo.debris-flow": entry("Debris flow", "A fast flow of mud, rock and debris down a slope, often from heavy rain on a burn scar."),
  "geo.earthquake": entry("Earthquake", "Ground shaking from a fault rupture, reported with a location, depth and magnitude soon after the event."),
  "geo.earthquake.early-warning": entry("Earthquake early warning", "A warning sent seconds before strong shaking arrives, issued from the first seismic waves of a rupture."),
  "geo.fireball": entry("Fireball or airburst", "A bright meteor or airburst over a region, sometimes with a sonic boom or fallen meteorites."),
  "geo.landslide": entry("Landslide", "Movement of rock or earth down a slope, after heavy rain, an earthquake or a thaw."),
  "geo.near-earth-object": entry("Asteroid impact risk", "A near-Earth object with a computed non-zero impact probability, rated on the Torino and Palermo scales."),
  "geo.space-debris": entry("Space debris", "Objects in orbit that fall back to the Earth."),
  "geo.space-debris.reentry": entry("Space debris re-entry", "An uncontrolled re-entry of a satellite or rocket body, with a predicted time window and ground track."),
  "geo.space-weather": entry("Space weather", "Solar activity that disturbs the magnetosphere and ionosphere, with effects on power grids, radio, GPS and satellites."),
  "geo.space-weather.geomagnetic-storm": entry("Geomagnetic storm", "A disturbance of the Earth's magnetic field on the NOAA G scale that can stress grids and degrade GPS."),
  "geo.space-weather.radio-blackout": entry("Radio blackout from a solar flare", "An X-ray flare on the NOAA R scale that blacks out HF radio on the sunlit side of the Earth."),
  "geo.space-weather.solar-radiation-storm": entry("Solar radiation storm", "High proton flux on the NOAA S scale that affects high-latitude flights, satellites and polar radio."),
  "geo.subsidence": entry("Sinkhole and ground subsidence", "A sudden collapse or slow sinking of the ground that damages roads, pipes and buildings."),
  "geo.tsunami": entry("Tsunami", "A series of sea waves from an earthquake, landslide or eruption, with watches, advisories and warnings for coasts."),
  "geo.volcano": entry("Volcano", "Unrest or eruption of a volcano, with alert-level and aviation colour-code changes from a volcano observatory."),
  "geo.volcano.ashfall": entry("Ashfall", "Ash plumes that close airspace and ash fall that harms lungs, roofs, water and engines downwind of a volcano."),
  "geo.volcano.ashfall-marine": entry("Ashfall at sea", "Ash that falls on boats and coastal waters downwind of a volcano."),
  "geo.volcano.eruption": entry("Volcanic eruption", "A volcano erupts, with ash, lava, gas or flows that are a danger to people near it."),

  "met.beach-hazards": entry("Beach hazards", "Dangers at a beach, for example rip currents and high waves, as a statement of a weather service."),
  "met.blowing-dust": entry("Blowing dust", "Wind that lifts dust and cuts the visibility, less severe than a dust storm."),
  "met.cold": entry("Cold", "Dangerous cold or wind chill that harms people, animals and pipes."),
  "met.cold.extreme": entry("Extreme cold", "Cold that is a danger to life with no shelter, as an extreme cold warning."),
  "met.cold.wind-chill": entry("Wind chill", "Wind and cold that freeze skin fast."),
  "met.drought": entry("Drought", "A long dry period, rated weekly by drought category, that leads to water limits, crop loss and fire risk."),
  "met.dust-storm": entry("Dust storm", "A wall of dust or sand that drops the visibility to near zero on roads."),
  "met.flood": entry("Flood", "Water over normally dry land from rain, rivers, snowmelt, ice jams or dam releases."),
  "met.flood.areal": entry("Areal flood", "Water over an area from heavy rain, slower than a flash flood."),
  "met.flood.coastal": entry("Coastal flood", "Sea water over coastal land from high tides, waves or a storm."),
  "met.flood.flash": entry("Flash flood", "A flood that rises within hours of heavy rain, a dam failure or a debris jam."),
  "met.flood.hydrologic": entry("Hydrologic conditions", "A statement of a weather service about river levels, snowmelt or the water supply."),
  "met.flood.lakeshore": entry("Lakeshore flood", "Lake water over the shore from wind and waves."),
  "met.flood.river": entry("River flood", "A river above flood stage at a gauge, with observed and forecast stages."),
  "met.fog": entry("Dense fog", "Fog that cuts visibility enough to cause road crashes and flight delays."),
  "met.fog.freezing": entry("Freezing fog", "Fog that freezes on roads and other surfaces."),
  "met.freeze": entry("Freeze", "Temperatures at or below freezing that kill crops and plants."),
  "met.freeze.hard": entry("Hard freeze", "Temperatures well below freezing for hours, which kill most crops and can burst pipes."),
  "met.frost": entry("Frost", "Frost on plants on a clear, calm night near freezing."),
  "met.heat": entry("Heat", "Dangerous heat that harms health, with heat warnings and heat risk levels."),
  "met.heat.extreme": entry("Extreme heat", "Heat that is a danger to life, as an extreme heat warning."),
  "met.lightning": entry("Lightning", "Cloud-to-ground lightning near a place, a direct risk to people outdoors and a common cause of fires and outages."),
  "met.marine": entry("Marine weather", "Gales, hazardous seas, freezing spray and special marine warnings for boats and coastal waters."),
  "met.marine.brisk-wind": entry("Brisk wind at sea", "Strong wind at sea that is a danger to small boats."),
  "met.marine.fog": entry("Dense fog at sea", "Fog that cuts the visibility for boats on coastal waters."),
  "met.marine.freezing-spray": entry("Freezing spray", "Spray that freezes on ships and adds weight to them."),
  "met.marine.freezing-spray.heavy": entry("Heavy freezing spray", "A fast build-up of ice from spray that can capsize a ship."),
  "met.marine.gale": entry("Gale", "Wind of 34 to 47 knots at sea."),
  "met.marine.hazardous-seas": entry("Hazardous seas", "Waves that are a danger to most boats."),
  "met.marine.hurricane-force-wind": entry("Hurricane-force wind at sea", "Wind of 64 knots or more at sea, not from a tropical cyclone."),
  "met.marine.low-water": entry("Low water", "Water levels that are low enough to put boats aground."),
  "met.marine.small-craft": entry("Small craft", "Wind or waves that are a danger to small boats."),
  "met.marine.small-craft.rough-bar": entry("Small craft at a rough bar", "Breaking waves at the entrance of a harbor (a bar) that are a danger to small boats."),
  "met.marine.small-craft.seas": entry("Small craft in hazardous seas", "Waves that are a danger to small boats."),
  "met.marine.small-craft.wind": entry("Small craft in wind", "Wind that is a danger to small boats."),
  "met.marine.special": entry("Special marine weather", "A short warning for boats of strong wind, hail or waterspouts from a storm."),
  "met.marine.storm": entry("Storm at sea", "Wind of 48 to 63 knots at sea."),
  "met.outlook": entry("Hazardous weather outlook", "A daily forecast of the hazardous weather of the next days, before any watch."),
  "met.rain": entry("Heavy rain", "Rain heavy enough to flood streets, cellars and low ground, below the level of a flood warning."),
  "met.rip-current": entry("Rip current", "A strong current that pulls swimmers away from the beach."),
  "met.severe-weather": entry("Severe weather", "An official weather watch, warning or advisory from a national meteorological service for an area."),
  "met.special": entry("Special weather", "A short statement of a weather service about weather below the level of a warning, for example a strong storm."),
  "met.surf": entry("High surf", "Large breaking waves that are a danger to people on the beach and the shore."),
  "met.surge": entry("Storm surge", "A rise of the sea above the tide from a storm, with a flood of the coast that is a danger to life."),
  "met.thunderstorm": entry("Thunderstorm", "A storm with damaging wind, large hail or a long-lived wind event, with watches and warnings."),
  "met.thunderstorm.severe": entry("Severe thunderstorm", "A thunderstorm with wind of 58 mph or more, or hail of 1 inch or more, as a watch or a warning."),
  "met.tornado": entry("Tornado", "A rotating column of air in contact with the ground, with watches and radar-indicated or observed warnings."),
  "met.tropical": entry("Tropical cyclone", "A hurricane, typhoon or tropical storm, with forecasts, watches and warnings for coasts in its path."),
  "met.tropical.hurricane": entry("Hurricane", "A tropical cyclone with wind of 74 mph or more."),
  "met.tropical.storm": entry("Tropical storm", "A tropical cyclone with wind of 39 to 73 mph."),
  "met.tropical.typhoon": entry("Typhoon", "A tropical cyclone of the western Pacific with wind of 74 mph or more."),
  "met.wind": entry("Wind", "Strong wind that is not from a thunderstorm, from a lake wind to the extreme wind of a hurricane."),
  "met.wind.extreme": entry("Extreme wind", "Wind of 115 mph or more, near the eyewall of a strong hurricane."),
  "met.wind.high": entry("High wind", "Wind or gusts that damage trees, power lines and buildings."),
  "met.wind.lake": entry("Lake wind", "Wind on lakes that is a danger to small boats."),
  "met.winter": entry("Winter", "Heavy snow, blowing snow, freezing rain or snow squalls that close roads and break power lines."),
  "met.winter.blizzard": entry("Blizzard", "Snow and strong wind that cut the visibility to near zero for hours."),
  "met.winter.freezing-rain": entry("Freezing rain", "Rain that freezes on roads, trees and power lines."),
  "met.winter.ice-storm": entry("Ice storm", "A heavy build-up of ice that breaks trees and power lines."),
  "met.winter.lake-effect-snow": entry("Lake-effect snow", "Heavy bands of snow downwind of a large lake."),
  "met.winter.snow-squall": entry("Snow squall", "A short burst of heavy snow and wind that drops the visibility fast on roads."),
  "met.winter.storm": entry("Winter storm", "Heavy snow, sleet or ice from a winter storm, as a watch or a warning."),
  "met.winter.weather": entry("Winter weather", "Snow, sleet or ice that makes travel difficult, below the level of a winter storm."),

  "safety.civil-danger": entry("Civil danger", "An authority warns a large population of an event that is a danger to life, for example a contaminated water supply."),
  "safety.civil-emergency": entry("Civil emergency", "An authority warns of a large threat to public safety or property that is not weather."),
  "safety.crowd-crush": entry("Crowd crush or stampede", "Dangerous crowd density at an event or transit point that can cause a crush."),
  "safety.evacuation": entry("Evacuation", "Authorities order or advise people to leave an area now, with zones and routes."),
  "safety.local-emergency": entry("Local emergency", "An authority warns of an event in a local area that is a threat to safety, with less priority than a civil emergency."),
  "safety.national-emergency": entry("National emergency", "A national authority sends an emergency message to the whole country, for example an Emergency Action Notification."),
  "safety.public-lands-closure": entry("Park or public land closure", "A park, trail or recreation area closes or posts a danger notice."),
  "safety.recall": entry("Product recall", "A maker or regulator withdraws a product that can hurt people, with the product, the hazard and the remedy."),
  "safety.recall.consumer-product": entry("Consumer product recall", "A household product, toy or appliance is recalled for fire, injury, choking or other hazards."),
  "safety.recall.drug": entry("Drug recall or falsified medicine alert", "A medicine is recalled for contamination, wrong strength or bad labels, or a falsified version is found."),
  "safety.recall.food": entry("Food recall or public health alert", "A food is recalled or flagged for contamination, undeclared allergens or foreign objects."),
  "safety.recall.medical-device": entry("Medical device recall", "A medical device is removed or corrected because it can fail or harm the patient."),
  "safety.recall.vehicle": entry("Vehicle recall", "A vehicle or part is recalled for a safety defect, sometimes with a do-not-drive or park-outside notice."),
  "safety.scam": entry("Scam or fraud wave", "A scam that targets many people at this time, for example fake government calls, text tolls or disaster charities."),
  "safety.shelter-in-place": entry("Shelter in place", "People in an area are told to go indoors, close windows and stay, from a release, a fire or a threat."),
  "safety.wildlife": entry("Dangerous wildlife activity", "A bear, cougar, shark or other dangerous animal is active near people, or an area closes for it."),

  "security.active-threat": entry("Active shooter or attack in progress", "An attack is under way at a place, and the people near it must run, hide or avoid the area."),
  "security.air-raid": entry("Air raid or missile alert", "A siren-level alert for missiles, drones or aircraft over a region, telling people to take cover now."),
  "security.armed-conflict": entry("Armed conflict event", "Battles, strikes, shelling or violence against civilians in an area of armed conflict."),
  "security.blue-alert": entry("Threat to the police", "Police ask the public for help after an officer is killed or badly injured and the suspect is at large."),
  "security.child-abduction": entry("Child abduction", "Police ask the public to look for an abducted child, with a description of the child, the suspect and the vehicle."),
  "security.civil-unrest": entry("Protest, riot or civil unrest", "Demonstrations, riots or strikes that close roads, cause violence or bring curfews."),
  "security.crime": entry("Crime near a place", "Reported crimes or police incidents near a place, for awareness rather than immediate danger."),
  "security.curfew": entry("Curfew or movement restriction", "An authority orders people to stay home or limits movement in an area for a period."),
  "security.explosive-ordnance": entry("Unexploded ordnance or mine hazard", "Unexploded bombs, mines or shells found or present in an area, with closures and danger to people."),
  "security.kidnap": entry("Kidnap risk", "Kidnaps of residents or travelers in an area, often for ransom."),
  "security.law-enforcement": entry("Law enforcement warning", "Police warn an area of a danger, for example an armed person, a manhunt or a bomb threat."),
  "security.maritime-threat": entry("Attack or threat to shipping", "Piracy, armed robbery, missile or drone attacks and boarding of ships in a sea area."),
  "security.missing-person": entry("Missing and endangered person", "Police ask the public to look for a missing person who is in danger, for example an older person with dementia."),
  "security.terrorism": entry("Terrorism threat or attack", "A government warning of a terrorist threat, or a terrorist attack that has happened."),
  "security.travel-advisory": entry("Government travel advisory", "A government changes its advice on travel to a country or region for safety, health or security reasons."),

  "rescue.disaster-assistance": entry("Disaster recovery center or aid open", "Aid becomes available after a disaster: recovery centers, assistance programs, food and water points."),
  "rescue.search-and-rescue": entry("Search and rescue operation", "A search for missing people at sea, in the mountains or after a collapse, with a request to watch."),
  "rescue.shelter-open": entry("Emergency shelter open", "Shelters open for people who leave their homes in a disaster, with location and capacity."),

  "fire.burn-ban": entry("Burn ban and fire restriction", "A ban on open burning, fireworks or campfires from a county, state or land agency."),
  "fire.structure": entry("Structure fire and local fire incident", "A building, vehicle or local fire that fire services dispatch to, near a place of interest."),
  "fire.weather": entry("Fire weather", "Wind, heat and low humidity that let fires start and spread fast, as red flag warnings."),
  "fire.wildfire": entry("Wildfire", "An uncontrolled fire in vegetation, with incident location, size, containment and perimeter."),
  "fire.wildfire.hotspot": entry("Satellite fire detection", "A satellite hotspot that can show a new fire before any report, with no official confirmation."),

  "health.animal-disease": entry("Animal disease event", "An outbreak in animals, for example avian influenza in poultry or dairy herds, with a risk to the food supply and to people."),
  "health.drug-shortage": entry("Drug or medical supply shortage", "A shortage of a medicine or medical product that affects patients."),
  "health.drug-supply-threat": entry("Dangerous drug supply or overdose cluster", "A new adulterant or potent drug in the illicit supply, or a spike in overdoses in an area."),
  "health.hospital-capacity": entry("Hospital or emergency care strain", "Hospitals in an area are full, on diversion or closed, so emergency care takes longer."),
  "health.medical-emergency": entry("Medical emergency", "A person needs emergency medical care now, for example after a fall, an injury, a stroke or a heart attack at home."),
  "health.outbreak": entry("Disease outbreak", "An unusual cluster or spread of an infectious disease, reported by a public health agency."),
  "health.outbreak.foodborne": entry("Foodborne illness outbreak", "Illnesses linked to a food product, under investigation, often before or with a recall."),
  "health.travel-notice": entry("Travel health notice", "A health notice for travellers to a country, from usual precautions to avoid all travel."),
  "health.wastewater-signal": entry("Wastewater pathogen signal", "A rise in a virus or bacterium measured in sewage, an early sign of community spread."),

  "env.air-quality": entry("Air quality", "Ozone, particles or other pollutants at an unhealthy AQI level, observed or forecast."),
  "env.air-quality.smoke": entry("Wildfire smoke", "Smoke from near or distant fires that raises fine particles to unhealthy levels."),
  "env.air-stagnation": entry("Air stagnation", "Light wind and a stable air mass that hold pollutants near the ground for days."),
  "env.pest-quarantine": entry("Plant pest or animal disease quarantine", "A quarantine area for an invasive pest or plant disease that limits moving plants, wood or produce."),
  "env.pollen": entry("High pollen", "A high pollen index that affects people with allergy or asthma."),
  "env.smoke": entry("Dense smoke", "Smoke that cuts the visibility on roads, as a dense smoke advisory of a weather service."),
  "env.smoke.marine": entry("Dense smoke at sea", "Smoke that cuts the visibility for boats on coastal waters."),
  "env.spill": entry("Oil or chemical spill to the environment", "A release of oil or a hazardous substance into water or land, reported to the authorities."),
  "env.uv": entry("High UV index", "A forecast UV index high enough to burn skin in minutes."),
  "env.water": entry("Water quality", "Bacteria, toxins or sewage in drinking water, lakes, rivers or the sea."),
  "env.water.beach-advisory": entry("Beach advisory or closure", "A beach closed or under advisory because of bacteria, sewage or toxins in the water."),
  "env.water.drinking-advisory": entry("Drinking water advisory (boil water, do not drink)", "A notice that tap water is unsafe to drink without boiling, or not at all."),
  "env.water.harmful-algal-bloom": entry("Harmful algal bloom", "Toxic algae or cyanobacteria in a lake or coastal water that make swimming, drinking water or shellfish unsafe."),
  "env.water.sewage-overflow": entry("Sewage overflow", "Untreated sewage released to rivers or the sea from a storm overflow or a failed plant."),

  "transport.air": entry("Air transport", "Aircraft, airports and airspace."),
  "transport.air.accident": entry("Aircraft accident", "A crash or serious incident of an aircraft, with the operator, place and casualties."),
  "transport.air.conflict-zone": entry("Conflict zone airspace warning", "A regulator warns airlines of a risk to aircraft over a conflict zone."),
  "transport.air.disruption": entry("Airport delay, ground stop or closure", "Flights at an airport are held, delayed by a program or stopped, or the airport closes."),
  "transport.air.hazard-weather": entry("Aviation weather hazard", "SIGMETs and advisories for turbulence, icing, convection, volcanic ash or low ceilings along air routes."),
  "transport.air.notam": entry("Airspace restriction (NOTAM or TFR)", "A notice that closes or restricts airspace, a runway or a navigation aid, including temporary flight restrictions."),
  "transport.rail": entry("Rail transport", "Trains and railways."),
  "transport.rail.accident": entry("Train accident or derailment", "A derailment, collision or grade crossing crash, sometimes with a hazardous materials release."),
  "transport.road": entry("Road transport", "Roads, highways and border crossings."),
  "transport.road.border-wait": entry("Border crossing delay", "Long waits or closure at a land border crossing."),
  "transport.road.incident": entry("Road closure, crash or work zone", "A road is closed or slowed by a crash, works, weather or an event."),
  "transport.sea": entry("Sea transport", "Ships, ports and sea routes."),
  "transport.sea.navigational-warning": entry("Navigational warning", "A warning to ships of hazards, for example drifting objects, firing exercises or failed lights."),
  "transport.space": entry("Space transport", "Rocket launches and the returns of objects from space."),
  "transport.space.launch": entry("Rocket launch or reentry hazard area", "A launch with closures of airspace, sea and roads, and possible debris or sonic booms."),
  "transport.transit": entry("Public transit", "The buses, trains and ferries of public transit."),
  "transport.transit.service-alert": entry("Public transit disruption", "A bus, train or ferry line is suspended, rerouted or delayed."),

  "infra.cloud": entry("Cloud services", "The public cloud regions and services that apps and sites run on."),
  "infra.cloud.outage": entry("Cloud provider outage", "A failure of a public cloud region or service that takes down the apps and sites built on it."),
  "infra.dam": entry("Dams and levees", "The dams and levees that hold back water above people."),
  "infra.dam.failure": entry("Dam or levee failure", "A dam or levee fails or is likely to fail, with fast flooding below it."),
  "infra.fuel": entry("Fuel supply", "The supply of gasoline, diesel and other fuels to stations and homes."),
  "infra.fuel.shortage": entry("Fuel shortage", "Stations run out of fuel after a refinery, pipeline or supply problem."),
  "infra.gas": entry("Gas and liquid pipelines", "The pipelines of natural gas and hazardous liquids."),
  "infra.gas.pipeline-incident": entry("Gas or liquid pipeline incident", "A leak, rupture or explosion of a gas or hazardous liquid pipeline."),
  "infra.gnss": entry("Satellite navigation", "GPS and the other satellite navigation systems."),
  "infra.gnss.interference": entry("GPS or satellite navigation interference", "GPS signals are jammed, spoofed or tested in an area, which affects aircraft, ships and phones."),
  "infra.internet": entry("Internet", "The networks, routes and shared providers of the internet."),
  "infra.internet.bgp": entry("Route hijack or route leak", "Wrong routing announcements that send traffic of a network to another network or drop it."),
  "infra.internet.dns-cdn": entry("DNS, CDN or certificate provider failure", "A failure of a shared internet provider (DNS, content delivery or certificates) that breaks many sites at once."),
  "infra.internet.outage": entry("Internet outage in a region or network", "A large drop in internet reachability in a country, region or provider network, from cuts, power or faults."),
  "infra.internet.shutdown": entry("Government internet shutdown", "An intentional cut or throttle of internet or platforms by an authority, often during protests or exams."),
  "infra.payments": entry("Payment systems", "Card networks, bank transfers and the other payment services."),
  "infra.payments.outage": entry("Payment or banking system outage", "A failure of card, bank transfer or payment services, so people cannot pay or get paid."),
  "infra.postal": entry("Postal service", "The mail and parcel services."),
  "infra.postal.disruption": entry("Postal service disruption", "Mail and parcel delays or suspensions from weather, facility closures or strikes."),
  "infra.power": entry("Electric power", "The supply of electric power from the grid to its customers."),
  "infra.power.grid-emergency": entry("Grid emergency or conservation appeal", "A grid operator warns that supply is short, asks people to save power, or orders rotating outages."),
  "infra.power.load-shedding": entry("Scheduled load shedding", "Rotating power cuts by a published schedule and stage when a national grid lacks supply."),
  "infra.power.outage": entry("Power outage", "Loss of electric power to customers in an area, with counts of customers out and restoration estimates."),
  "infra.power.psps": entry("Planned power shutoff for wildfire safety", "A utility turns off power in an area ahead of high wind to prevent its lines from starting fires."),
  "infra.saas": entry("Online services", "The web services, apps and platforms that people use."),
  "infra.saas.outage": entry("Online service outage", "An outage of a web service, app or platform that a person uses, from its own status page or user reports."),
  "infra.structure": entry("Structures", "Buildings, bridges, tunnels and the other built structures."),
  "infra.structure.collapse": entry("Building or bridge collapse", "A building, bridge, tunnel or other structure fails, often with casualties and closures around it."),
  "infra.supply-chain": entry("Supply chains", "The ports, routes and suppliers that move goods."),
  "infra.supply-chain.disruption": entry("Supply chain or shipping chokepoint disruption", "A block at a port, canal or strait, or a supplier failure, that delays goods and raises prices."),
  "infra.telecom": entry("Telephone and network", "The phone, mobile and emergency call networks."),
  "infra.telecom.911-outage": entry("911 outage", "Emergency calls to 911 do not connect in an area, with an alternate number to call."),
  "infra.telecom.outage": entry("Phone or mobile network outage", "Loss of mobile, landline or cable service in an area, from storms, cuts or carrier faults."),
  "infra.timekeeping": entry("Time zone or clock rule change", "A change to a time zone rule or daylight saving date that breaks schedules and software clocks."),
  "infra.water": entry("Water service", "The supply of tap water to an area."),
  "infra.water.outage": entry("Water service outage", "Loss of water pressure or supply to an area after a main break, pump failure or plant fault."),

  "cbrne.biological": entry("Biological agent incident", "A deliberate or accidental release of a dangerous pathogen or toxin."),
  "cbrne.explosion": entry("Industrial explosion", "An explosion at a plant, depot or storage site, with fire, blast damage and smoke."),
  "cbrne.hazardous-materials": entry("Hazardous materials", "A release of toxic gas or liquid from a plant, a vehicle or an attack that endangers people nearby."),
  "cbrne.nuclear-plant": entry("Nuclear power plant", "An event at a nuclear plant reported to the regulator, from a minor fault up to an emergency classification."),
  "cbrne.radiological": entry("Radiological hazard", "Raised radiation levels or loss of a radioactive source, with protective actions."),

  "cyber.advisory": entry("Security advisory", "A government or vendor advisory about a flaw or a threat."),
  "cyber.advisory.ics": entry("Industrial control system or medical device advisory", "A government advisory on a flaw in control systems or medical devices that run plants, utilities or hospitals."),
  "cyber.campaign": entry("Active threat campaign advisory", "A joint government advisory on an active attacker group, its methods and the steps defenders take now."),
  "cyber.data-breach": entry("Data breach", "Personal data stolen from an organization, which can expose the accounts and identity of the people in it."),
  "cyber.ddos": entry("Large denial-of-service attack", "A flood of traffic that takes a service, a network or a country offline for a period."),
  "cyber.ransomware": entry("Ransomware", "Ransomware attacks and the groups that do them."),
  "cyber.ransomware.victim": entry("Ransomware attack on an organization", "A ransomware group claims an organization as a victim, which can stop services that people depend on."),
  "cyber.software": entry("Software lifecycle", "The facts of the lifecycle of a software product that change its risk."),
  "cyber.software.end-of-life": entry("Software end of support", "A product or version that stops getting security fixes on a known date, so its users must upgrade."),
  "cyber.supply-chain": entry("Software supply chain", "A threat to the packages and the build tools that software depends on."),
  "cyber.supply-chain.malicious-package": entry("Malicious software package", "A package in a public registry that contains malware, often a typo-squat or a hijacked maintainer account."),
  "cyber.vulnerability": entry("Software vulnerability", "A flaw in software that an attacker can use."),
  "cyber.vulnerability.exploited": entry("Vulnerability exploited in the wild", "A software flaw that attackers use now, so systems that run the product need a patch or a work-around fast."),
  "cyber.vulnerability.published": entry("New vulnerability in software that a person uses", "A newly published CVE or advisory for a product, library or package, with severity and fixed versions."),

  "market.bank": entry("Banks", "A bank fails or its service stops, which can block a person's money."),
  "market.bank.failure": entry("Bank failure", "A regulator closes a bank and the FDIC names the acquiring bank or pays depositors."),
  "market.bank.outage": entry("Bank service outage", "A bank or neobank reports that its app, cards or transfers do not work."),
  "market.broker": entry("Brokers", "The brokers that hold the investments of people."),
  "market.broker.outage": entry("Broker outage", "A broker reports that trading, deposits or withdrawals do not work."),
  "market.credit": entry("Credit", "The credit of countries, banks and companies."),
  "market.credit.rating": entry("Credit rating change", "A rating agency changes the rating of a country, bank or company."),
  "market.credit.sovereign-debt": entry("Sovereign debt event", "A government default, downgrade, or debt ceiling event."),
  "market.crypto": entry("Crypto market events", "A stablecoin, exchange or chain has a failure that can lock or lose a person's funds."),
  "market.crypto.chain-halt": entry("Blockchain halt", "A blockchain stops making blocks or confirming transactions."),
  "market.crypto.depeg": entry("Stablecoin depeg", "A stablecoin trades away from its peg by more than a set amount."),
  "market.crypto.exchange-outage": entry("Crypto exchange outage", "A crypto exchange or custodian reports degraded trading, deposits or withdrawals."),
  "market.crypto.hack": entry("Crypto hack or exploit", "A protocol, bridge or exchange loses funds to an attack."),
  "market.exchange": entry("Exchange operations", "An exchange has a system problem or a closure that changes when a person can trade."),
  "market.exchange.closure": entry("Market closure or early close", "An exchange closes for a holiday, an early close or an unscheduled event."),
  "market.exchange.outage": entry("Exchange system issue", "An exchange reports that its systems are affected or down."),
  "market.halt": entry("Trading halts", "Trading stops in a whole market or in one security."),
  "market.halt.marketwide": entry("Market-wide circuit breaker", "US equity trading stops across all markets after a large index fall (codes MWC1, MWC2, MWC3)."),
  "market.halt.security": entry("Single-security halt", "Trading stops in one security for news, volatility (LULD) or a regulatory reason."),
  "market.halt.suspension": entry("Regulatory trading suspension", "The SEC suspends trading in a security, mostly for doubts about its information."),
  "market.indicator": entry("Economic indicators", "The indicators that tell the state of the economy."),
  "market.indicator.recession": entry("Recession indicator", "A recession indicator crosses its trigger level."),
  "market.investor": entry("Investor protection", "The warnings and actions of regulators that protect investors."),
  "market.investor.alert": entry("Investor fraud or enforcement alert", "A regulator warns of a fraud or acts against a firm that a person can use."),
  "market.prediction": entry("Prediction market signals", "A forecast market or crowd forecast changes in a way that tells of a coming event."),
  "market.prediction.move": entry("Sudden probability move", "The probability of an outcome changes by a large amount in a short window."),
  "market.prediction.new": entry("New market with activity", "A new market opens on a topic the person follows and gets real volume."),
  "market.prediction.resolution": entry("Market resolution", "A market closes and resolves to an outcome, which confirms an event."),
  "market.prediction.threshold": entry("Probability crosses a set level", "The probability of an outcome passes a level that the person chose."),
  "market.prediction.volume": entry("Volume surge", "Trading volume in a market rises far above its normal rate, which can tell of private information."),
  "market.price": entry("Price and rate moves", "A price that touches a person's costs or savings moves sharply."),
  "market.price.commodity": entry("Commodity price shock", "The price of crude oil, natural gas or another commodity moves sharply."),
  "market.price.fuel": entry("Fuel price change", "Retail gasoline or diesel prices in a region rise past a level or by a set amount."),
  "market.price.fx": entry("Sharp currency move", "An exchange rate moves more than a set percent, which changes the cost of travel or transfers."),
  "market.price.move": entry("Sharp asset or index move", "A stock index, stock or crypto asset moves more than a set percent in a set window."),
  "market.price.volatility": entry("Volatility spike", "A volatility index, for example the VIX, rises sharply, which marks market stress."),
  "market.rates": entry("Interest rates", "The interest rates that touch the loans and savings of people."),
  "market.rates.mortgage": entry("Mortgage rate change", "Average mortgage rates pass a level or move by a set amount in a week."),
  "market.release": entry("Scheduled economic releases", "A scheduled economic release or central bank decision is due or is out."),
  "market.release.fomc": entry("FOMC decision or minutes", "The Federal Open Market Committee publishes a rate decision, statement or minutes."),
  "market.release.macro": entry("Macro data release", "A government agency publishes a scheduled economic number, for example CPI, jobs or GDP."),

  "civic.court-ruling": entry("Court ruling or docket change", "A court rules or a docket changes in a case that matters to the person."),
  "civic.economy": entry("Government economic actions", "A government takes an economic action, for example sanctions or a fiscal step, that touches a person."),
  "civic.economy.enforcement": entry("Financial enforcement action", "A financial regulator takes an enforcement action against a firm."),
  "civic.economy.fiscal": entry("Federal fiscal stress", "Federal cash or debt data shows a debt-limit squeeze or another fiscal stress."),
  "civic.election": entry("Election date or voting change", "Election dates, registration deadlines, polling place changes and results that affect a voter."),
  "civic.emergency-declaration": entry("Emergency or disaster declaration", "A government declares an emergency or a major disaster, which opens aid and changes rules."),
  "civic.government-operating-status": entry("Government office closure or delay", "Government offices close, open late or change to telework, from weather or other events."),
  "civic.government-shutdown": entry("Government shutdown", "A lapse in funding stops or slows government services, payments and parks."),
  "civic.labor-action": entry("Strike or labor action", "A strike or walkout that stops a service: transit, ports, postal, schools or hospitals."),
  "civic.planned-event": entry("Large planned event", "A concert, game, march or festival that brings crowds, closures and traffic to an area."),
  "civic.public-holiday": entry("Public holiday", "A public holiday that closes offices, banks and markets and changes transit schedules."),
  "civic.regulation": entry("New rule or law", "A new regulation, rule or law that changes what a person or a business must do."),
  "civic.sanctions": entry("Sanctions action", "OFAC adds, removes or licenses sanctions on a country, bank, company or person."),
  "civic.school-closure": entry("School closure or delay", "Schools close, start late or go remote for weather, threats or other events."),
  "civic.tax-relief": entry("Disaster tax relief", "A tax authority postpones deadlines for people in a disaster area."),
  "personal.death": entry("Death in the household", "A person of the household dies, and the others must act on the care, the money and the papers."),
  "personal.income-loss": entry("Loss of income", "A person loses a job or another main source of money, for example after a layoff, a closure or an injury."),

  [UNKNOWN_KIND]: entry("Unknown event", "An event that the kind tables of an adapter do not know."),

  "system.admin": entry("Administrative message", "A message about the alert systems, not about a hazard."),
  "system.test": entry("Test message", "A test of an alert system. It shows that the path works, and it does not wake a person."),
  [HEALTH_KIND]: entry("Health of a source", "The health of a source of signals, from its fetches and its timing."),
  ...Object.fromEntries(Object.entries(HEALTH_ENTRIES).map(([state, value]) => [`${HEALTH_KIND}.${state}`, value])),
  [COVERAGE_KIND]: entry("Coverage of a kind", "A report that too few healthy sources cover a kind at a place. The covered code follows the prefix."),
  [QUOTA_KIND]: entry("Quota of a channel", "The quota of a channel: the units that it can send in one window of its provider."),
  ...Object.fromEntries(Object.entries(QUOTA_ENTRIES).map(([stage, value]) => [`${QUOTA_KIND}.${stage}`, value])),
  [BALANCE_KIND]: entry("Balance of a provider", "The balance of a paid provider account: the money that its channels can spend."),
  ...Object.fromEntries(Object.entries(BALANCE_ENTRIES).map(([stage, value]) => [`${BALANCE_KIND}.${stage}`, value])),
  [CLOCK_KIND]: entry("Clock of the computer", "The wall clock of the computer that runs the alert system."),
  [`${CLOCK_KIND}.step`]: entry("Step of the clock", "The wall clock of the computer stepped back or forward against its monotonic clock."),
  [LOG_KIND]: entry("Log of the runtime", "The log file of the runtime of the alert system. The state of the runtime comes from it."),
  [COPY_KIND]: entry("Copy of the system", "Another copy of the alert system on another computer. The copies share their reports and their sends."),
  ...Object.fromEntries(Object.entries(COPY_ENTRIES).map(([stage, value]) => [`${COPY_KIND}.${stage}`, value])),
  [`${LOG_KIND}.recovered`]: entry("Recovery of the log", "The log file was broken. The runtime moved it into quarantine and started a new file with the events that it read."),
  [DRILL_KIND]: entry("Drill of a path", "A drill of the path of the life-safety warnings: the provider, the phone and the person."),
  [`${DRILL_KIND}.run`]: entry("Drill", "A drill message. It wakes the person, and an acknowledgment in its time passes the drill. It is not a warning."),
  [`${DRILL_KIND}.failed`]: entry("Failed drill", "No acknowledgment of a drill came in its time. A real warning on this path can also go without an answer."),
  [ESCALATION_KIND]: entry("Escalation of a warning", "The steps that send a warning to a person again on more channels, until the person acknowledges it."),
  [CHANNEL_KIND]: entry("Channel of the system", "A channel that takes the alerts to the people, as a push service, a text service or a call service."),
  [`${CHANNEL_KIND}.down`]: entry("Down channel", "The calls of a channel to its provider fail. The other channels of each person carry the alerts until a call passes again."),
  [STORE_KIND]: entry("Store of the system", "A store of the alert system that fills from its sources after each start, as the store of the outlines of the zones."),
  [TELL_KIND]: entry("Message of the operator", "A short private message from the operator of the alert system to one person. It is not a warning."),
  [`${TELL_KIND}.needs-you`]: entry("Needs you", "A message of the operator: the person must decide or act."),
  [`${TELL_KIND}.done-you-asked`]: entry("Done", "A message of the operator: a request of the person is done."),
  [`${TELL_KIND}.live`]: entry("Live", "A message of the operator: a change is live."),
  [`${STORE_KIND}.empty`]: entry("Empty store", "A family of a store has no entry in the time after a start. Each feature that reads the family works without it."),
  [LIMIT_KIND]: entry("Send limit of the system", "The most new alerts that one person gets in one window. The digest tells each alert that the limit holds."),
  [`${LIMIT_KIND}.held`]: entry("Alerts held", "The send limit holds new alerts for the person. The next digest tells each one. The limit does not hold a life-safety warning."),
  [`${ESCALATION_KIND}.exhausted`]: entry("Exhausted escalation", "A person did not acknowledge a real warning in the time of the policy. The people who watch the person get this report."),
};

/**
 * The old codes of the taxonomy, each with its new code. A code leaves `TAXONOMY` only with an entry
 * here, so a stored kind with an old code still parses. The file `taxonomy.lock.json` holds each code
 * of `TAXONOMY` and each old code, and a test holds the lock. Thus the removal of a code is a deliberate step.
 */
export const KIND_ALIASES: Readonly<Record<string, string>> = {};

/**
 * This function gives the new code of an old code, and each other code with no change. It also maps
 * the covered code of `system.coverage.<code>`. The schemas apply it before the check of `knownKind`.
 */
export function canonicalKind(code: string, aliases: Readonly<Record<string, string>> = KIND_ALIASES): string {
  if (Object.hasOwn(aliases, code)) return aliases[code] ?? code;
  if (!code.startsWith(`${COVERAGE_KIND}.`)) return code;
  const covered = code.slice(COVERAGE_KIND.length + 1);
  return Object.hasOwn(aliases, covered) ? `${COVERAGE_KIND}.${aliases[covered] ?? covered}` : code;
}

/**
 * This function tells if a code is in the taxonomy. The code must be a code of `TAXONOMY`, or
 * `system.coverage.<code>` for a code of `TAXONOMY` that is not a code of the system. It is the one
 * rule for each code: the adapters, the schemas of the configuration and the source atlas use it.
 */
export function knownKind(code: string): boolean {
  if (Object.hasOwn(TAXONOMY, code)) return true;
  if (!code.startsWith(`${COVERAGE_KIND}.`)) return false;
  const covered = code.slice(COVERAGE_KIND.length + 1);
  return categoryOf(covered) !== "system" && Object.hasOwn(TAXONOMY, covered);
}

/** This function gives the codes that are not in the taxonomy, sorted and each one time. The gate tests of the adapters use it. */
export function unknownKinds(codes: Iterable<string>): string[] {
  return [...new Set([...codes].filter((code) => !knownKind(code)))].sort(compareCodeUnits);
}

/** This function gives the parent of a code: the code without its last part, or `null` for a category. */
export function parentKind(code: string): string | null {
  const end = code.lastIndexOf(".");
  return end < 0 ? null : code.slice(0, end);
}

/** This function gives the plain name of a code. A code that `TAXONOMY` does not have gives the code itself. */
export function kindLabel(code: string): string {
  return Object.hasOwn(TAXONOMY, code) ? (TAXONOMY[code]?.label ?? code) : code;
}
