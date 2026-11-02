# Places

Carriers say where a scan happened in free text: "Härkingen", "LEIPZIG - DE", "Sort centre
Chicago IL", "FRANCE". The Node-only `/places` entry point turns this text into coordinates,
or `null` when it cannot place the scan confidently.

```js
import { locatePlace, placesForEvents } from 'universal-parcel-scraper/places';

locatePlace('LEIPZIG - DE');
placesForEvents(['Härkingen', 'Zürich'], { carriers: ['swiss-post'] });
```

## How a place is chosen

- The text is split into fields and phrases, and facility words ("hub", "Paketzentrum",
  "sort centre") are dropped, with an article before one ("EL AEROPUERTO"), also when one is
  joined to its town ("TrondheimSorter"). Spanish and Catalan "del" is also read as "de el":
  "AEROPUERTO DEL PRAT" is El Prat's. What is left is matched against town names, and translations
  for larger towns ("Genf", "Cologne"). Translations are those in the town's own languages, in
  English, or in the languages of the largest carrier markets ("Londres"): another language's
  name for a town can be a word carriers print ("Pastas", Pasto in Lithuanian, is the Lithuanian
  for post). A translation of three Latin letters is left out: it
  is a code or a stray transliteration more often than a name ("Lon" for Lognes). So is
  GeoNames' transliteration of a name in another script ("Noman" is Norman in Japanese), but
  not the Chinese reading of a Chinese town's own name ("Shen Zhen"). A Spanish town also goes
  by its name without the article it begins with ("BORGES DEL CAMP"), and a Greek one with χ
  written "ch", as Greek carriers do, where GeoNames writes "kh" ("VRACHATI"), a German one
  without the kind of municipality GeoNames ends its name with ("Freiburg (Elbe) Flecken"), and a Chinese
  city of 100,000 people by its pinyin name with "shi" (city) joined to it ("shenzhenshi"),
  unless a town has that name (Huangshi). Translations
  include old names, so nothing confirming it, only a city's of 100,000 people places a town
  (Trenton was "Mill Hill"). A town found by a translation keeps the carrier's words for its own
  name: "Asuncion del Paraguay" is "Asuncion". Words in capitals or small letters alone give
  the town's own name instead ("KOELN" is Köln). Each half of a bilingual name counts
  ("Biel/Bienne"), but not a direction that halves a district's ("Neustadt/Süd").
- A town is looked up at the start or the end of a name, and between other words when it is
  a city of 100,000 people where the parcel is ("Example Reading Station Lockers"), or
  something else in the text confirms it. Nothing after a linking word such as "am", "bei",
  "sur" or "nad" is looked up as a town on its own: "Bernau bei Berlin" is not in Berlin. A
  letter and a full stop after the first word are read as the linking words they abbreviate:
  "Frankfurt a.d. Oder" is Frankfurt an der Oder, "Weil a. Rhein" Weil am Rhein, but the
  letters of an initialism are not: "C.O. RIO DE MOURO" is in Rio de Mouro. "St" and
  "Ste" are also read as Saint and Sainte: "ST QUENTIN FALLAVIER" is Saint-Quentin-Fallavier.
  A saint's title other words follow is not a town of its own: "SAN FDO. DE H." is no San in
  Mali.
- A longer place name is the place it names, not a town that shares a word of it, when it
  is a town where the text or the parcel is, or a city and the shorter name names no town
  there: "Cartagena de Indias" is in Colombia, "Santiago de Compostela" in Spain, but
  "East London MC" on a British parcel is in London. A town within 50 km of the longer name
  may still be the one meant ("NEW DELHI"). Elsewhere, a town nothing but a country confirms
  is no word of a longer name some town has, unless it is a city of 100,000 people where the
  text or the parcel is: "Mill Hill Post Office" is not in Hill.
- A country after the last dash is taken off, as DHL Express prints it ("BENIN CITY -
  NIGERIA", "AMSTERDAM - NETHERLANDS, THE"). Georgia stays: it is also a US state.
- Chinese, Japanese and Korean names match in their own script. "广东省深圳市" is read as
  a province followed by a city, and a county-level city after its prefecture's city, in
  the same province, is where the scan is: "浙江省金华市义乌市" is Yiwu, and so is a town
  (镇, 乡) after its city. A town's name can
  start a facility's ("义乌转运中心"); a word for a facility or a part of town ("中心",
  "新城") names no town. Latin letters next to such script are a word: "Changsha市".
- A larger town of a country written in Cyrillic also matches by its names in Cyrillic
  ("Тюмень").
- A country also goes by its Chinese or Japanese name ("日本").
- A smaller town in the same region that ends the part of the text a city begins, within
  30 km of the city, is the carrier's site there: "TORINO MONCALIERI (999)" is in Moncalieri.
  So is one the city follows alone in brackets, within 100 km: "Kerpen (Köln)" is in Kerpen.
- A town named whole with what follows it in brackets is that town, in a country the text
  names, however small: "Frankfurt (Oder)", and "Neustadt (Holstein)" for Neustadt in
  Holstein, with a linking word between the two ("in", "an der", "am", "bei"). Neither part
  then names another town ("Essen (Oldenburg)" is not Essen).
  An airport the text names there comes first ("PARIS ORLY"). A hyphen makes the two one name,
  a quarter of the city ("Zürich-Mülligen"), and so does a regional border between them.
- Bigger towns win, and context breaks ties: a country written in the text, a state,
  province or canton, by code or by name ("STERLING - Virginia - USA", "CURITIBA - PR"), a
  Swiss postcode, then the countries of neighbouring scans, the parcel's destination and
  its carriers' countries. `placesForEvents` reads those from the catalog for the carrier
  ids in `carriers`: the countries a carrier delivers in, unless they are more than six, and
  the country of its clock. `carrierCountries` adds countries by code.
- Towns of one name in one country, more than 50 km apart and neither twice the other's size,
  are told apart by the scans around them: Royal Mail's "Kennington DO" between London's
  scans is in London, by Ashford in Kent. Alone, the scan gets no place.
- In the United States, Canada, Australia and Brazil, a scan's stated offset tells towns of
  one name apart, when another of the parcel's towns there keeps its own, different offset:
  "Lincoln" at -04:00 after Boston is not in Nebraska. The town whose state keeps that offset
  nearest the scans around it wins. A state split between zones keeps either, so Florida's
  Panhandle keeps Central time; a carrier that states one offset everywhere tells nothing.
  A scan without an offset there takes its town's: Central west of the Apalachicola River,
  except Gulf County south of the Intracoastal Waterway, as 49 CFR 71.5 draws the line.
- Context does not outweigh a city of a million people, or a town of 100,000 ten times the
  size of the namesake context picks, when it lies nearer the way between the scans around
  it: "Warsaw" between Lviv and New York is in Poland.
- A state, province or canton written after the town holds: "Earth City, MO" is not Earth
  in Texas.
- A state or province written alone by its code ("WA", "VIC, AU", "SA AUSTRALIA") is in the
  first country the parcel is likely in that has it, before the country, town or airport its
  letters also name (Saudi Arabia, Vic in Spain, Tashkent). The place is that country's and `region` holds the
  code. Letters that are also a country's keep naming it on a parcel through that country.
- Two letters after the town are a country when a town of that name is there ("MONTE CARLO
  MC"), or when the parcel is. Otherwise they may be a province or an office: "PINEROLO
  (TO)" is in the province of Turin, not Tonga, and Royal Mail's "Norwich MC" is a mail
  centre, not Monaco. A depot's number in brackets can follow the code ("Vilvoorde - BE
  (depot 0001)"). The town's own province settles it, then a town of that name where the
  parcel is, then, for a code no comma or bracket sets apart, any town of that name. A code
  that is also a US state or a Swiss canton only favours its country's towns, after a comma
  or in brackets alike ("Bad Bevensen, DE", "Bad Bevensen (DE)"), unless the text also names
  that country or a region of it in words: "Example Town, HOLLAND, NL" is in the Netherlands,
  not Holland in Michigan, and "Luxembourg, LU" is the city. Alone, between empty fields
  (",,,DE"), the code is the country. With no town at all, a
  code in brackets or after a space is no country on a parcel known to be elsewhere, and the
  scan gets no place. MC and DO after a name that is no town of Monaco or
  the Dominican Republic are Royal Mail's, on any carrier's parcel: its mail centre or a
  British town of that name, else the United Kingdom for a name with a British region in it
  ("Mid Wales MC"), else no place.
- A field with only facility words and a country's name ("DPD GERMANY DE"), or its "-ian"
  word ("Latvian sorting center"), places that country, when the text's code or the parcel
  puts the parcel there. A country's name with a depot's number in brackets, as BRT names a
  partner's depot abroad ("SPAIN (12)"), is that country.
- A US military post office ("Fpo, AE", "APO AP 96001") names a region of the US armed
  forces, not a country: AE there is not the Emirates, and the base can be anywhere in the
  region. The scan gets no place, and `trackingPlace` and `trackingLocationCountry` give it
  no country.
- A field that only names a region is that region: it places a town of that name only if
  the town lies in it, and otherwise places the region's country ("Guangdong Province").
  The words of a region's name are not towns elsewhere: "Cabo Delgado" is in Mozambique,
  not "Delgado" in El Salvador, nor is a region's name a small town of its country outside
  it ("Mid Wales MC" is not Wales in Yorkshire). A region the parcel's countries have wins over
  a namesake abroad. Carriers still print some regions' former names: "Distrito Federal" is
  Mexico City's on a Mexican parcel and Brasília's on a Brazilian one. A region named by points
  of the compass alone places its country only where the parcel is: Royal Mail's "South West
  Parcel Hub" is not in Cameroon.
- A town nothing confirms needs 15,000 people. Otherwise the scan gets no place: a wrong
  dot is worse than none. Postcodes only confirm a name, never stand in for one. A name a
  division's word follows ("Houjie District") is no town GeoNames counts no people in.
- A town only its name places, in a country nothing else puts the parcel in, is a namesake
  when it is far from the other scans: more than 6,000 km off the way between the scans
  around it that hold ("Cornwall" in Ontario between two scans in England), or, where the
  scans stop, more than 3,000 km from them and from the parcel's countries. It gets no
  place, and tells the scans around it nothing. Where the scans stop, a name no other town
  has and a city of a million people stay: nothing says the parcel did not go there.
- India Post ends an office's name with its PIN code, and abbreviates some names past
  reading ("KOL AP TMO 700052"). Text that names no town, not even one nothing confirms, is
  placed in the PIN's town from `pincodes.json` when the scan or the parcel is in India. A
  foreign airport code ("Office - FRA …") names an office of exchange abroad: its PIN is the
  Indian office's, and places nothing.
- USPS places some scans only at a ZIP Code ("ZIP Code 60600", or the code twice,
  "60600,60600", on a parcel that may be in the US). Its first three digits name
  an area, placed from `zipcodes.json` in the town that holds most of the area's codes. An
  area many towns share places nothing.
- Text that names only a country gets that country, marked `country`, so the map shades
  the country instead of pinning a town. A DHL operation followed only by a country name
  also places that country; the carrier's name alone supplies no country. A country name
  followed only by facility words is a city of that name of 100,000 people or more, on a
  parcel in the city's country and not in the named one: GIG Logistics' "BENIN HUB" is in
  Benin City.

## Scans filed away from the parcel

An office can file a scan where the parcel is not. DHL Express updates the customs clearance
at the destination's office while the parcel is still being sorted at the origin, and a
delivering carrier registers a parcel in its own country before the parcel has left. Given each
scan's stage and time (`stages` and `times`), `placesForEvents` gives such a scan no place, so a
map does not send the parcel there and back. The scan keeps its text.

Only a scan of paperwork (`registered`, `pending` or `customs`) or one that names only a
country can be away. The scans that handle the parcel in a town say where it is, and the scan
is away when:

- it lies more than 300 km off the way between the handling scans before and after it,
  measured from a country's nearest town;
- the parcel would have had to fly faster than 1,000 km/h, give or take two hours, between it
  and the handling scan before or after it. Clocks without an offset prove nothing;
- the handling scans around it are in other countries, and the parcel only comes to its
  country later;
- it registers the parcel (`registered` or `pending`) in a country it names alone, after the
  parcel was handled elsewhere and before it was handled there.

A country between two handling scans abroad can be the way through: a Hong Kong hub between
Shenzhen and Leipzig stays.

The gazetteer loads once per process, from the packaged asset. `preloadPlaces()` loads it
ahead of the first lookup. Results are cached in memory; consumers decide whether to
persist them or serve a parcel when place resolution fails.

## Clocks

`placeTimeZone` gives the zone a place keeps its clock on: its country's, or in a country of
several zones, its state's or province's (the US, Canada, Australia, Brazil) or the zone whose
principal place in the tz database's `zone.tab` lies nearest. A place that names only such a
country takes the zone most of its people live on, or its state's when `region` names one. `airportTimeZone` reads an airport its code
names, alone ("AMS"), with an airport word ("JFK Airport") or with its country ("BNE, AU"): a
bare code the parcel's way does not bear out places nothing, but it tells a forwarder's clock.

`dateLocalClocks(carrier, result)` dates the scans a carrier gives on a wall clock in no stated
zone (`local_time`). The zone comes from the scan's place, read with the scans around it; a scan
filed away from the parcel is on the clock of the office that filed it, which it lends to no other
scan; else from the leg the parcel was on: the last scan before it with a zone of its own (a town, a state,
a country of one clock or an airport), or once a scan since says the parcel landed or reached its
destination, the next one after, so later scans do not move it. With none before, it is the next
one, unless the parcel lands on the way there; else from the parcel's
destination, when the carrier delivers there; else from the carrier's home clock: its catalog
zone, or with UTC there, its first country's. The scan keeps `local_time` and gains `time`,
`time_zone` and `time_zone_basis` (`place`, `neighbour`, `destination` or `carrier`). Node lookups through
`trackCarrier()` and `createTracker()` apply it to a carrier's own answer. Scans dated by their
day alone keep it; `carrierHomeZone(carrier, result)` gives the home clock a host can start
such a day on.

A deduced zone can be wrong near a border between zones, or for a carrier that keeps one clock
everywhere. A zone the carrier states, or one learned by comparing its clocks with copies that
carry an instant, belongs in its adapter, which then dates the scan itself.

## Lost letters

A carrier can relay a town with an accented letter lost to the replacement character (U+FFFD),
as Hermes does for some of its French partner's depots. `restoreLostLetters(result)` fills each
lost letter in a scan's "Town, Country" place, and wherever the wording repeats that town, from
the one spelling of a town of that country that fits: inside a word in the case of the letters
beside it, starting one in the town's own. A gap two spellings fit (Münster and Munster) stays.
Node lookups through `trackCarrier()` and `createTracker()` apply it to a carrier's own answer.

## Facilities

Some carriers say exactly where a scan happened, and the town's centre can be kilometres off:
Swiss Post's "Zürich Briefzentrum" is in Mülligen.

- `facilities.json` places sorting centres by the six-digit site number Swiss Post ends its
  scan text with ("Zürich Briefzentrum 801050"), whichever source relayed the scan. The text
  must also start with the site's town. The place keeps the town as its name; a distinct facility name is returned as `site`.
  Only sites seen in scans are listed, each with the
  OpenStreetMap element its point comes from. The first four digits are often not a
  postcode (8920 and 8520, the Urdorf and Frauenfeld parcel centres, are none), so unknown
  sites stay on their town.
- A scan that names an airport is placed at it, when the airport is within 60 km of the
  town: by its code in brackets ("Frankfurt Airport (FRA)"), by a word of its name that is
  neither the town nor the country ("LONDON-HEATHROW"), by the words of its name together
  ("Chicago O Hare"), by a part of the text that is its name and no town's
  ("LONDON - GATWICK"), or as the town's one airport when the text says airport ("LIEGE AIRPORT"). The
  city an airport serves is no word of its name ("Seoul Gimpo" is Gimpo), and an airport
  named after its town alone has none. A part with an airport word that names an airport or
  its town places the scan there up to 150 km out ("Narita Airport, Tokyo"). With an airport
  word, the words of one airport's name that no town has place it alone ("O Hare Airport"),
  when they are two words or six letters. The place keeps the town as its name and returns
  the airport as `site`.
- A code with an airport word ("JFK Airport") or the airport's country or state ("BNE, AU")
  is that airport, whatever town elsewhere has its letters, unless a town of 100,000 people
  in that country has them ("POA, BR" is Poá). An operator in brackets does not change that
  ("MUC(DE-POST), DE").
- A bare code ("CDG") places nothing alone: three letters are too often something else.
  Among a parcel's scans it is the airport when the way bears it out: the airport is in a
  country of the parcel or of the scans around it, within 300 km of one of them, or no more
  than 3,000 km off the way between them, or between the scan before and the destination (a
  hub such as Doha between China and Europe). A town of 100,000 people keeps its letters
  ("POA" is Poá). Otherwise the code is no town nothing else confirms ("CAN" is no Çan in
  Turkey).
- A country's three-letter code alone ("ITA") is that country, when the parcel is there.
  Elsewhere it is no town nothing else confirms: "ITA" is not Itá in Paraguay.
- A UPU office of exchange ("DEFRAA": a country's two letters, an airport's code, an office
  letter) is in the town of the airport its code names, when the airport is in that
  country. The country's name can follow the code, as bpost writes it ("BEBRUA Belgium").
  Some codes name a UN/LOCODE location no airport of the country has; the offices seen in
  scans are listed by that location's name ("FRROIC" is at Roissy-en-France). A code no list
  holds, or whose letters another country's airport has, is in its country when the parcel is
  known to be there and no town has its letters for a name.
- A station named by an airport's code and a number, as iMile names its Italian ones ("BLQ
  01"), is in that airport's town, when the parcel is in the airport's country. Elsewhere the
  code places nothing.
- `hubs.json` lists hubs named after a place that is not their town ("ROISSY" is the
  Charles de Gaulle airport, not Roissy-en-Brie), with the town and airport they stand for,
  and hubs the gazetteer cannot place by name, with their point and its source: in a village
  too small for it ("SEKOCIN STARY", by Warsaw), in a district it leaves out (Royal Mail's
  "LANGLEY HWDC" by Heathrow, which would otherwise be Langley in Canada), in a town GeoNames gives no population
  (Cainiao's "Fenggang Town" is in Dongguan, not the Fenggang of Jiangxi), or under a short
  name ("TERRASSON", Mondial Relay's agency in Terrasson-Lavilledieu), in the wrong one of
  two towns ("Shatian Town" is Cainiao's warehouse in Dongguan), or named after an area
  (Royal Mail's "South Midlands MC" is in Northampton: `site` then holds the facility's
  name). A longer place name that contains a hub's ("Beauregard-de-Terrasson",
  "Roissy-en-Brie") is that place. A hub with `carriers` counts only on their parcels,
  ahead of the towns of its name, which still win when the text says which one: on a DPD
  parcel "Buchs, CH" is the depot in Buchs ZH, and "Buchs SG" the town in St. Gallen. SPX
  Brazil's "ShiYan", whose wording names Shenzhen, is in Shenzhen's Shiyan, not the city in Hubei.
  MRW's "Meres (Plataforma)" is its platform in Meres, Asturias, not the town in Turkey.
  Royal Mail's mail centres named after an area ("Thames Valley MC", in Swindon, not Valley
  on Anglesey) count on Royal Mail and Parcelforce parcels, and on any parcel with MC after
  the name. China Post's exchange offices go by the initials of their Chinese names
  ("BJGJHHJ" is Beijing's 国际互换局, its international exchange office), placed at their city.
  A carrier's site named after the country it serves, without a town, is in that country on
  that carrier's parcels: Mondial Relay's "MR Pays Bas" is its Dutch network.
- A carrier's own coordinates, supplied through the `points` option, move a scan
  to the facility when they are within 30 km of the town its text names. Scans with the same
  text share a point, so a carrier that places some scans of an office keeps them together.

## Data

`node scripts/generate-places.mjs` builds `places.tsv.br`: GeoNames towns of 1,000 people
or more and first-level regions (by the local name in a country's dump where it reads one:
"Catalunya"), the postal localities of Switzerland, Liechtenstein, their
neighbours, the Benelux and the United States, the Canadian municipalities postal areas are named after (Canada
Post still addresses Scarborough and North York, now part of Toronto), the municipalities of
some European countries and Taiwan that no town is named after (with the older romanizations of
Taiwan's: "Ta-yuan" is Dayuan), the town seats of Guangdong and
Zhejiang, Mexican municipalities named unlike their seats, as alternate names of the seats
("Cajeme" is Ciudad Obregón), Swiss and
Liechtenstein postcodes, OurAirports airports with
scheduled service, and the Natural Earth country label points in `countries.json`.
Decisions about what to include are commented in the script.
`node scripts/generate-pincodes.mjs <directory.csv>` builds `pincodes.json` from the
[All India Pincode Directory](https://www.data.gov.in/resource/all-india-pincode-directory-till-last-month)
CSV: each PIN goes to the GeoNames town of 50,000 people or more nearest its head office or
delivery offices, within 25 km, a tenfold population counting for 5 km. PINs with no such
town are left out.
`node scripts/generate-zipcodes.mjs` builds `zipcodes.json` from the GeoNames US postal
codes: a ZIP Code prefix goes to the town that holds most of its codes, three or more.
Then run `node scripts/generate-region-towns.mjs`: the carrier catalog keeps
the towns of a few US states and Canadian provinces from it. `npm run test:generated`
checks this projection.

GeoNames data is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
([geonames.org](https://www.geonames.org)) and facility points come from
[OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL). Natural Earth and
[OurAirports](https://ourairports.com/data/) are public domain. The pincode directory is
published by the Department of Posts under the
[Government Open Data License - India](https://www.data.gov.in/Godl). Credits are included
in [NOTICE](../NOTICE).
