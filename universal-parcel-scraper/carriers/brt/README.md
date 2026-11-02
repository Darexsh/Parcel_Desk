# BRT

Tracks shipment numbers, BRTcodes, BRT parcel IDs and `EOB` customer parcel IDs
through BRT's anonymous detailed event portal. Other shipment references use universal providers.
Universal providers call it BRT Bartolini, its former company name, with the
identifier type in brackets; those names are its aliases.

## How it works

One HTTP request retrieves the event table and shipment metadata. The returned
identifier must exactly match its own metadata field. Shipment numbers use the
form's POST route; BRTcodes use its linked event page. The [official tracking form](https://vas.brt.it/vas/sped_numspe_par.htm?lang=en)
keeps these identifier types separate. The modern consumer portal exposes a shorter
progress view and requires recipient verification for more details; the linked
event portal supplies the scan history without that extra input.
Detection and adapter eligibility use the same catalog shapes.

The page labels scans in Italian or English, as its `lang` asks, with the same
dates, times and places. A lookup whose `language` is Italian asks for `lang=it`,
any other for `lang=en`; recognition reads English. The status map reads both
labels. An Italian page with a label the map has no English for, such as a
locker's scans, is asked for again in English, and stands if that fails. A
delivery reads `Consegnata` in Italian and `Delivered` in English. A scan stored
with one language's label takes the other's in place, at the same instant and place.

Fifteen-digit parcel IDs, printed on the parcel label, go through the form's
parcel search, which only covers about the last two months. Its result page does
not repeat the parcel ID, so a second request reads the shipment's own parcel
list and the result is accepted only when that list names the requested ID.

The same search finds a customer parcel ID ("ID collo cliente"), the barcode a
sender applies to its parcels. The adapter takes those of `EOB` and seventeen
digits. Because the sender chooses them, their rule is low confidence: BRT is
asked and named only when it finds the ID. BRT reads them case sensitively.
Several shipments can share one, and the adapter only reads a reply that shows
a single shipment.

Chronopost and the DPD network bring parcels from abroad under a BRTcode they
track too. BRT's history of such a parcel starts at their import depot, named
`CHR-…` or `DPD…`, often with only the shipping data the partner sent. Tracking
that BRTcode also asks the partner, with what is left of the budget:
Chronopost's own tracking service, or DPD's guest service, which answers for
the whole group with each milestone once, at its newest date and without a
place. Without its answer BRT's stands; recognition reads BRT alone. DPD's
map leaves its hand-over, depot intake and transit scans unstaged, because an
origin depot can follow an import's customs. Before BRT's hand-over they are the
acceptance and transit, unless DPD staged the parcel past acceptance first. The status map
answers a partner's scan, which has a code, by that partner's map. It leaves the transit
scans DPD had before it took the parcel in out on purpose, and has no answer for the
hand-over and intake, whose stage the scans before them decide.

BRT's COLLECTED in a shipment that starts at such an import depot is its hand-over from
the partner, which had already accepted and moved the parcel, so it is in transit, with or
without the partner's leg and whichever depot records it. Only in a shipment that starts at
one of BRT's own depots is the collection the acceptance, which is what the status map
answers for the wording. A depot named by carriers alone, as `DPD-COLISSIMO`
is after the parcels Colissimo hands the DPD network, names no place, so its scans have
no location. The app's scan-identity policy lets a row stored with that place keep its
identity when its instant and wording agree, and its stage too, or the acceptance read
now as the hand-over.

Until BRT has processed such a BRTcode it answers TIS0564 and names no partner.
Tracking then asks Chronopost, then DPD, under the same code. BRT is the DPD
group's network in Italy, so a partner's answer stands for BRT's only when it
shows the parcel bound for Italy: an Italian destination or a scan placed in
Italy. Otherwise BRT's inconclusive answer stands and none of the partner's
scans become BRT's. DPD's guest answer, which names no places, seldom shows it.

While its tracker is down for maintenance, BRT redirects every page to a notice and the
lookup fails as maintenance. BRT's own site then sends a BRTcode to mybrt.it, the DPD group's
consumer portal, whose milestones the group's guest service gives too: each once, at its
newest date and without a place. A BRTcode is asked there, and its answer
stands for BRT's when DPD places the parcel in Italy. The milestones are staged as in DPD's
leg, and the hand-over is to BRT. The portal archives a parcel after thirty days. Any other
answer leaves the outage, so enabled providers answer. Shipment numbers and parcel IDs have
no such route.

BRT also sends parcels abroad through the DPD network. For a shipment of one
parcel that started at one of BRT's depots and names no delivering depot in
Italy, the detail gives the parcel's DPD number ("Parcel number dpd"). Once the
newest scan is at a DPD depot named after a single country with a DPD network
in the catalog, such as `DPD DE …`, that network is the `delivery_carrier` and
the DPD number the `delivery_tracking_number`. BRT copies that network's scans,
often with their dates alone; the network dates them.

## Notes

BRT's depots in Italy keep Italian civil time, which San Marino and the
Vatican share, so their scans become instants. A scan counts as one of them
when its place has BRT's depot form and names neither DPD nor a country, and
either the page names the depot delivering the shipment in Italy or the scan
is at the depot where the shipment started. The DPD network's depots abroad
come in the same form, and a shipment BRT hands to a partner abroad names no
delivering depot, so its other places are not known to be in Italy. A depot
named after a country, such as `DPD-ROV-AUSTRIA`, shows either that country's
clock or BRT's own; where both read the same, as for Austria, Germany or
France, its scans become instants too. So do a depot's two letters, as in
`CHR-FR SUD`, where it is not known to be in Italy and they are the code of a
country on Italy's clock. BRT's own depots open with their province's two
letters, so a code of a country on another clock proves nothing: `GE` is
Genoa's and Georgia's, and `DPD-GE` keeps local times. Other clocks stay local times, as do
places without a depot code and a clock that the change to or from summer time
repeats or skips. A scan BRT dates by its day alone, as it does a delivery
round, keeps that day as `local_time`, and the catalog's `dateOnlyScans` tells
consumers no copy has its clock; a date that is no calendar day remains
provider text. BRT delivers only in Italy, so its catalog zone is Rome's: a
host starts such a day there, and a local time no place settles is dated on
it. The newest scan, when dated, gives the last update
and, for a delivery, the delivery instant. Source order determines current
status even when the newest clock is unresolved.

Arrival at a locker or BRT-fermopoint, or at the parcel shop of the partner
abroad that delivers, means ready for pickup; collection from a locker or
BRT-fermopoint means delivery. A notice left after a missed delivery is a failed attempt. A shipment returned to its sender ends with a delivery scan
at the origin depot; after a return scan that delivery reads as returned.
The English page's TURMOIL is the scan the Italian page names MANIFESTAZIONE
PUBBLICA, a public demonstration holding the parcel up: an exception until a
later scan moves the parcel on. Held-parcel records and links to a delivering partner are not part of the
history.

The partner's dated scans before BRT's first scan beyond the shipping data
join the history below BRT's other scans, with the shipping data, in time order
when every clock among them is dated. A BRT clock without an offset may be up to
14 hours ahead of UTC, so a partner scan must be older than that. While BRT has only
the shipping data, a newer partner scan gives the current status.

Recipient details, sender references and shipment identifiers other than the
requested identifier and that DPD number are excluded from the result.

A negative requires the portal's matching parcel-label error, in either language. BRT answers a
shipment number it has not found with its TIS0564 error, "Shipment not found or
still being processed" ("Spedizione non trovata oppure ancora in elaborazione"),
and the parcel search gives the same sentence without the code. It also answers a shipment not processed yet and a parcel ID older than the
search reaches, so these exact replies stay inconclusive with the reason
`portal_not_found`, unless a partner shows a BRTcode bound for Italy. A shipment shown with an empty scan table is a `NoHistoryError`.
Empty replies, redirects and generic HTTP errors remain inconclusive.

Links to the shipment pages (`/vas/sped_…`) and the root of vas.brt.it name
BRT; its other pages, such as pickup orders and help, name none. Any link to
mybrt.it, the consumer portal, names BRT: La Poste names its partner DPD with
that link for parcels BRT delivers, under a BRTcode.

## Testing

Set `BRT_TRACKING_NUMBER` to an authorized shipment number, BRTcode or parcel ID and optionally
`BRT_UNKNOWN_NUMBER` to a valid-looking unknown code, then run
`npm run test:carriers:live -- carriers/brt`.
