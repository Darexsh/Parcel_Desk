# Universal providers

The universal providers follow parcels for many carriers at once: the aggregators
ParcelsApp, Ship24, 17TRACK and Postal Ninja, and UPU, the postal union's own data. The
library uses them as fallbacks, when a carrier has no dedicated adapter or its adapter finds
no history or only part of it. They are not carriers a user can select.

The aggregators run only when the caller names them in `providers` (`SCRAPER_PROVIDERS` for
the CLI and the server). UPU is on by default. Every eligible enabled provider receives the tracking
number. [universal.ts](universal.ts) owns the factories, the order and the provider names.

| Provider | Retrieval | Steps | Strength |
| --- | --- | --- | --- |
| [Ship24](ship24/README.md) | Signed anonymous JSON POST, local Chromium recovery | `direct`, `browser` | Fast, broad, carrier hints |
| [ParcelsApp](parcelsapp/README.md) | Anonymous form POST with postcode, TRAWL recovery | `direct`, `retry`, `trawl` | Fuller histories, destination legs |
| [17TRACK](seventeentrack/README.md) | TRAWL capture (compatibility build) | `trawl` | Per-leg multi-operator histories |
| [Postal Ninja](postal-ninja/README.md) | TRAWL widget, then results page. Local Chromium is compact-only | `trawl` or `browser` | Alternative full histories (opt-in) |
| [UPU](upu/README.md) | Anonymous JSON GET | `direct` | Cheap last-resort postal history |

## Order

The default order is **ParcelsApp → Ship24 → 17TRACK → UPU**. Selecting `Postal Ninja` adds
it after the other aggregators, for a number no carrier is named for and for a carrier whose
evidence shows Postal Ninja history. A carrier with results in [coverage.json](coverage.json) gets
its own order, graded by [coverage.ts](coverage.ts), but Postal Ninja stays after the other
aggregators. UPU needs a checksum-valid S10 number and always stays last. Checksum-valid China Post `C…CN` and `L…CN` numbers start with 17TRACK.
[COMPARISON.md](COMPARISON.md) explains the order, and [COVERAGE.md](COVERAGE.md) compares
results carrier by carrier.

Each provider is asked once per lookup. Remembering which one answered for a parcel, and
resting one that failed, is the consumer's job. Peek's
[routing notes](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md) show
one way to do it.

## Reach

[reach.json](../docs/reach.json) records how many carriers an aggregator says it follows, with the
page that says so. The README's headline uses the largest. It is the aggregator's own count,
and [the benchmark](../benchmark/README.md) holds what was measured.

## Shared behaviour

- `UniversalTracker.fetch()` tries providers in order until one succeeds, otherwise it
  throws `UniversalTrackingError` with every failure. `createTracker()` calls
  `fetchSource()` per provider, each under its own budget.
- Numbers are uppercased with spaces, dots and dashes removed, and must match
  `^(?=.*\d)[A-Z0-9]{4,40}$`. Every result must be bound to the requested number.
  A USPS routing barcode is requested as its package identifier, without the `420`
  prefix and the recipient's ZIP code. A number of that shape without a single package
  identifier (a failed check digit, or a 34-digit barcode whose two readings pass it and
  the Mailer ID layout does not settle) is never sent, as typed or as either reading:
  `fetchSource()` throws `indeterminate` with reason `usps_routing_barcode` before any
  request. [ARCHITECTURE.md](../ARCHITECTURE.md) has the split rule.
  A placeholder number, such as zeros or 123456789 (`isPlaceholderNumber`), is never
  sent either: providers merge other shipments under it, so `fetchSource()` throws
  `invalid_input` with reason `placeholder_number` before any request.
  A number of seven characters or fewer is sent only with its carrier: many carriers issue
  numbers that short, and a provider's guess of the carrier can change between lookups, each
  time to another shipment's history. Without one, or with `unknown`, `fetchSource()` throws
  `NoHistoryError` with reason `short_number` before any request.
- A supplied postcode is passed to every provider; ParcelsApp and 17TRACK use it. The
  carrier's time zone is passed too. It is used only for scans with no trustworthy zone of
  their own. So is the carrier's catalog id: 17TRACK asks again for that carrier when its own
  detection finds no history from it ([its README](seventeentrack/README.md)).
- UI notices (postcode or country prompts, sign-in requests, "no information"), the
  recipient's delivery preferences, DHL's detail line "Keine weiteren Details
  erforderlich" ("no further details required"), 17FEIA's estimated departure and the
  flight DHLink, Intel-Valley or Mayi Yinfu book, written before the flight, never become
  events. Neither does a bracketed time or date with no words, a language's label with nothing
  after it ("(中文:)"), nor an entry whose wording
  no rule reads and that is dated within five minutes of the lookup: providers stamp their
  notices with the moment they answer. A result made only of input prompts raises `input_required`.
  A generic "On the way" beside a specific scan at the same instant and place, as FedEx
  writes it, is a copy of that scan and is dropped. Cainiao's "Pending shipping by the
  seller" and the sentence of GLS's progress bar that points to the detailed tracking below
  keep no time when dated after the lookup: the seller's deadline and GLS's delivery estimate.
- `fetchSource()` treats a history in which no scan has an instant (only wall times with
  no known zone) as inconclusive: `indeterminate` with reason `undated_history`, so the
  chain moves on. UPU is exempt, because its local clocks are by design.
- Privacy: a non-delivered event that mentions a PIN, access code, door number or
  signature is dropped, and a delivered event's text becomes `Delivered`. Recipient
  fields are never read. A place leaves out a branch's postcode, and a postcode given
  alone as a place, as UPU posting scans relay it, becomes the country its code names
  or no place. A place loses a country given twice, the destination's country a line
  appends to its warehouse in China ("Shanghai, United States"), and the town and ZIP code
  China Post's feed adds after a US facility's town and state.
- One wording-to-stage vocabulary serves all providers. Unmatched wording stays
  `pending` and never inherits the shipment's stage. GLS's "The parcel has reached the
  ParcelShop" is read by the scans around it: after a carrier scan the parcel waits for
  collection, before one it is the sender's drop-off. [status.ts](status.ts) declares it,
  with 17TRACK's sub-statuses, as the status map `statusMapAnswer()` asks for the scans the
  parcel app files under the carrier `unknown`.
- English return instructions and a return in progress remain exceptions. Completed
  return wording can mark sender delivery; starting the return cannot complete it.
- An exactly worded voided label ("Parcel Void", "Shipment voided") is an exception even
  when a provider files it as generic transit: it was cancelled before shipping. A
  relabel that mentions a void is not.
- A carrier name reported by a provider is a hint. A consumer may try that carrier's
  adapter, and adopts the carrier only when that adapter confirms the shipment. A name is
  not proposed as `discovered_carrier` when the number fails a check digit that the
  carrier's adapter verifies before any request (`ADAPTER_CHECKED_RULES` in
  [shared/hints.ts](shared/hints.ts)), whatever other carriers' rules match it, because
  that adapter would refuse it as invalid input. The postal union's feed, which an
  aggregator lists as "UPU" or "Universal Postal Union", is not a carrier.
- A carrier followed by its country, such as "BRT (IT)", names that carrier when the
  country keeps one clock and it is the carrier's clock or home. A brand followed by a
  country, such as "GLS (FR)", names the brand's one network there in the same way. A brand
  with a worldwide network, as DHL has DHL Express, or with two networks in the country, stays
  unresolved. So does DPD: its networks
  share one guest service that answers for any DPD parcel, and 17TRACK writes "DPD (BE)" for
  parcels DPD places in the Netherlands. Recognition names the network from DPD's current
  country for the parcel.
- Several names can be the legs of one journey, such as DHLink and SwiftX, its last-mile
  partner. When every name is in the catalog, the hint is the one carrier whose rules fit
  the number, or the one a preferred rule backs. When no rule fits, Cainiao, which follows a
  parcel under its delivery carrier's number, leaves the one carrier named beside it, such as
  MailAmericas for an S10 number only postal detection takes. Otherwise a carrier whose
  numbers all have a layout of their own (only high-confidence rules) was named for its leg,
  and the one carrier left is the hint. Beside Cainiao, which brings parcels from abroad under
  their delivery carrier's number, a bare brand names its network that delivers at home:
  "Evri Group" is Evri UK, since Evri International hands parcels to partners abroad.
  Plain "Evri" is Evri UK in any case: providers name Evri International in full or by its
  GlobalEco tracker.
- A bare brand none of whose networks fits the number names a group, such as "DPD Group"
  beside BRT, DPD's network in Italy. Beside a carrier whose rule fits the number, it leaves
  that carrier's hint; a name outside the catalog still leaves none. When a carrier named in
  full and a network the bare brand leaves to the number both fit, and no preferred rule
  backs either, the carrier named in full is the hint.
- A brand's network none of whose rules fits the number names the brand's network the
  number points to, as a bare brand would: ParcelsApp names DPD France for DPD UK's depot
  numbers with their check character, which DPD France's adapter refuses.
- The names `Ship24`, `ParcelsApp`, `17TRACK`, `Postal Ninja`, `Track718` and `UPU` are public, and
  consumers store them. Don't rename them.

## Shared implementation

- [shared/result.ts](shared/result.ts): input normalization, event construction, notice
  and privacy filters, wording classification, history projection.
- [shared/hints.ts](shared/hints.ts): reported carrier names to catalog ids, and whether
  a name is new to the catalog.
- [shared/scans.ts](shared/scans.ts): scan vocabularies of carriers whose labels providers
  relay (YTO, Paack's page labels, Emile's status texts, CDEK's leg labels and FIRST LINE's rows): stage and
  stored wording of the carrier's own labels, original or translated, and the return leg that
  follows a return scan.
- [shared/capture.ts](shared/capture.ts): TRAWL response decoding and capture errors.
- [core/runner](../core/runner/index.ts) runs steps and records telemetry.
  [core/errors](../core/errors/index.ts) holds the shared failure categories.

`TrackingCaptureError` and the `SeventeenTrack*Error` classes carry diagnostic
`reason`/code fields. TRAWL build and session-cache settings live in
[trawl](../trawl/README.md).

## Adding or changing a provider

- Keep the adapter, parser tests, synthetic fixtures and one README in its folder.
- Add the name to `UniversalSource` in `types.ts` and `shared/result.ts` and to
  `COVERAGE_SOURCES` in `coverage.ts`. Register the factory in `universal.ts`, and add the
  name to `BROWSER_SOURCES` in `plan.ts` when it needs the browser service. A new name is a
  minor release, and consumers that store names have to accept it.
- Change the default order only with evidence, and record it in
  [COMPARISON.md](COMPARISON.md).
- Add the provider's results to [coverage.json](coverage.json) with
  `scripts/coverage-probe.mjs`, then run `npm run generate` to rebuild the COVERAGE.md
  tables.
- Add the name to `SOURCES` in `scripts/benchmark-data.mjs` and run the
  [benchmark](../benchmark/README.md) for it: `node scripts/benchmark.mjs probe --sources <name>`.
- Run the package checks.

Track718 is an opt-in source restricted to Juxi Express. That carrier uses Track718, ParcelsApp
and Ship24, leaving 17TRACK out. See [the scoped integration](track718/README.md).

[Track123](track123/README.md) is an additional opt-in public-page fallback restricted to named FedEx lookups. Its guest flow uses no paid API credentials.
