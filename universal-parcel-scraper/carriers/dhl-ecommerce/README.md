# DHL eCommerce

DHL's webshop parcel division, formerly DHL Global Mail. German DHL Paket is
[dhl](../dhl/README.md). The national parcel networks have their own carriers:
[Benelux](../dhl-ecommerce-nl/README.md), [UK](../dhl-ecommerce-uk/README.md),
[Iberia](../dhl-ecommerce-es/README.md) and [Poland](../dhl-ecommerce-pl/README.md).

## Retrieval

The `direct` step posts one anonymous lookup to `api.dhlecs.com/webtrack/v4/tracking`,
the endpoint configured by [DHL Webtrack](https://webtrack.dhlglobalmail.com/).
It covers the Americas network, including its international parcels. Recognition
uses only this HTTP lookup so ambiguous numbers can reach DHL eCommerce early.

The `browser` step retains the global tracking page's `www.dhl.com/utapi` lookup
for shipments missing from Webtrack, histories Webtrack has not published,
interactive challenges, and regional network or server failures. Webtrack misses
do not establish that DHL's global network has no shipment. Rate limits,
malformed replies, cancellation and spent budgets stop the lookup. Browser
lookups are serialized per instance.

Opt-in browser recognition goes straight to the global page after an inconclusive
HTTP check. It requires dated activity and returns the history with its confirmation.

A USPS routing barcode opens with the recipient's ZIP code. Every lookup asks for the
package identifier after it instead, which Webtrack also tracks, and the result reports
that identifier as `canonical_tracking_number`. A barcode without a single identifier is
refused before any request.

Webtrack also finds a package by the shipper's own package id, which is unique only within
that shipper's account: a seven-digit number returned another shipper's parcel. Numbers
shorter than ten characters, below DHL's own identifiers, are refused before any request.

## Parsing

Webtrack must return one identified package matching the requested number or
alias. Its `trackedValue` binds an alias to that package, as DHL's own client
does; the alias can differ from all concrete shipment identifiers. UTAPI accepts
one `ecommerce` shipment from the exact requested response URL because it can
return a different customer-confirmation identifier.

Timestamps use explicit offsets, the event's country or an identified hub. Webtrack
also names each scan's clock: a US zone (`ET`, `CT`, `MT`, `PT`), a fixed
abbreviation such as `PDT`, an offset such as `+07`, or `LT` for the place's own
time. A US label holds at a US place or one that names no country; at a place in
another country the place's own zone holds, as for `LT`. At a hub or US state the
label is checked: a hub or one-zone state keeps its own clock, since Arizona stays
on standard time (except the Navajo Nation, read as the rest of the state) and
Hawaii has its own zone; a state split between zones must be one the label can name;
and an abbreviation's offset must be one the place's clock has on that date, which
also settles a repeated hour. A code shared by a state and a country, such as `CA`, is read as the state
when the label fits it. A clock that does not fit, falls in an hour a clock change
skips, or falls in one it repeats without an abbreviation, remains `local_time`, as
do other unresolved Webtrack clocks. A UTAPI wall clock without a zone, or in an hour
its place's clock change skips or repeats, also remains `local_time`; UTAPI clocks
with an offset beyond fourteen hours or otherwise malformed are omitted. Converted
instants use UTC. Scans keep each source's newest-first order unless every one has an
instant. The coarse status does not replace a more precise
latest scan, and delivered descriptions omit signatures. Recipient addresses and
customer references are excluded.

Webtrack also gives the product name, the weight in pounds, and the last-mile
partner with its own number for the parcel. The partner is named from the label
onwards, so it is reported only once a scan shows it has the parcel, with its
number when that differs from the one asked for. `USPS` and `DAI_DIRECT` (DAI Post
in Australia) are Webtrack's own codes; another code is read with the partner link
beside it, as other partner names are. `MIRROR` means DHL delivers itself.

While a parcel is en route, Webtrack adds an `EN ROUTE` row without a place,
stamped with the time of each request. It is an echo of the status, not a scan,
so it is skipped. Webtrack can also list a scan twice under one event id, with two
spellings of its place; one row is kept, with the fuller place. The handover to the
last-mile partner ("TENDERED TO DELIVERY SERVICE PROVIDER", "HANDED OVER TO PARTNER
CARRIER") is in transit, and so is USPS accepting the parcel after it.

The parcel app's review asks the same wording rules (`statusMap`). A scan that only
UTAPI's status code staged stays open there, since the stored scan does not keep the code.

## Limitations

US parcels handed to USPS carry a USPS number, with or without the 420 routing
prefix. Detection offers DHL eCommerce next to USPS for the `9261` and `9361`
families and Webtrack's answer attributes the parcel.
`GM` numbers shorter than the sixteen to eighteen digits detection selects DHL eCommerce for
are DHL's too: its guide to tracking labels gives eCommerce IDs from ten characters, typically
starting with `GM`. Other carriers' generic rules fit eight to fifteen digits after two letters,
so detection only suggests DHL eCommerce first for them.
eBay International Standard Delivery's `ESUS` numbers are a low suggestion shared with
[Asendia](../asendia/README.md), since eBay names Webtrack for them and Asendia carries some.
S10 numbers starting `UU` and ending `DE` are a low suggestion too. The `U` range marks
letter-post items with goods and no customer tracking, and Deutsche Post's offices abroad,
such as DHL eCommerce's in Chicago, issue them under `DE`, so the series is not DHL
eCommerce's alone. Detection keeps the postal answer, and recognition asks Webtrack first.

Webtrack has regional coverage. The global route needs local Chromium because
UTAPI challenges direct requests; the page passes the challenge and repeats the
lookup. UTAPI's not-found reply ends the step as not found, and a shipment only
another DHL service carries, such as a DHL Paket parcel or a Deutsche Post item,
ends it as inconclusive with the reason `portal_not_found`: DHL eCommerce answered
that it holds no shipment under the number. Other error replies still end as a timeout. Sender names and estimates are
returned only when the chosen source publishes them.

## Testing

Run `npm run test:carriers:live -- carriers/dhl-ecommerce`. The synthetic HTTP
miss runs without credentials. Set `DHL_ECOMMERCE_TRACKING_NUMBER` outside the
repository to check an authorized Webtrack shipment.
