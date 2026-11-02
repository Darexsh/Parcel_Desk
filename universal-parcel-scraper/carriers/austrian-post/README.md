# Austrian Post

Tracks domestic 22-digit numbers and S10 postal numbers, its own and those of
mail other posts send to Austria, through the public tracking website's
anonymous GraphQL read. It also takes the 24-digit EURODIS
barcode of a parcel it sends abroad through that network, which its tracker
follows to the partner that delivers it, and the fourteen-digit number of a
Hermes Austria parcel it delivers, which Hermes's tracker links to Austrian
Post's.

## How it works

`direct` queries the public endpoint once and requires the returned item number
to match. Once a partner abroad takes a parcel over, the reply names it by the
partner's number, a EURODIS barcode or an S10 number, and keeps Austrian Post's
own as the original one, so either binds the reply; the adapter then reports the
partner's number as the canonical tracking number. The optional Post account
flow is unnecessary for public history.

## Notes

Summary codes and scan codes use different vocabularies. A scan marked `IZ` can
describe completed delivery; its reason and wording determine the event stage.
A parcel left in a Post Empfangsbox, a receiving box the recipient opens, is
ready for collection, and the `IZ` scan of the recipient taking it out is its
delivery, as the page's summary has them.
Timestamps carry explicit offsets, which are preserved. A scan place given
only as `PLZ` and a postcode, or as `PLZ` and a country code with or without
part of a postcode (`PLZ DE`), is the delivery area and is dropped, also when a
partner's scan abroad adds the country's name. A facility keeps its name
without the postcode, and a depot a partner names after `PLZ` stays as the page
shows it. The app's scan-identity policy lets a scan stored with a delivery
area as its place keep its row once it loses it, provided its instant, wording
and known stage agree.

Mail from abroad reaches Austrian Post when a caller names it, a provider names
it, or a result gives Austria as the destination of an S10 item. Its history
opens with the sending post's posting and dispatch as Austrian Post relays
them, staged by their wording, and a letter put through the letterbox is
delivered. Its customs scans, the declaration under way, a delay with its
reason, the item stored while an obstacle to the declaration stands and the
recipient's reply to it, are customs by their wording; for an obstacle the
page asks the recipient for the missing documents.

A scan can come without wording. The tracking page lists it under its date
and time alone, with no label from its codes, so it keeps its code but gets
no stage, and the status text comes from the newest scan with wording. `IMP`
is the exception: its code alone is the arrival in the destination country,
so it is in transit with or without wording, unless the wording names a
return or a delivery round. Without wording it takes Austrian Post's own
wording for that arrival, "Sendung im Zielland angekommen", rather than leave
the host a blank step. A scan with neither wording nor a code is skipped.

The query also asks for the measured size, in whole centimetres. It never
asks for the shipper, which the public page shows only after sign-in, or
anything about the recipient.

The delivery estimate is read as the tracking page reads it. Its dates are
days on Vienna time, and its start and end times, which carry offsets, make a
window when they fall on those days. The page shows it only while the item
is accepted, in distribution or out for delivery, and not once the newest
scan gives a delay, a problem to resolve or a missed delivery. A later scan
than the estimate's end also drops it.

## Limitations

Twenty-two digits stay a low-confidence suggestion, since USPS's and Estafeta's
rules take that length too. Austrian Post's parcel numbers start with `10`,
which no other carrier's 22-digit samples do, so `austrian-post-4` lists it
first for them and recognition settles on it when several carriers answer.
`austrian-post-3` suggests Austrian Post for 24 digits at low confidence, beside
the other carriers whose rules take that length, so recognition can ask its
tracker. No public EURODIS barcode of an Austrian Post parcel has been found,
so the corpus holds a synthetic one. No rule suggests Austrian Post for fourteen digits, which
Hermes Germany's and DPD's numbers share, so a Hermes number reaches it when
Hermes Austria's lookup hands the parcel over or the caller names Austrian
Post. Account-only delivery
options and recipient details are not retrieved. The estimate follows the
page's code and has not been checked against a live value. A shipment listed
without scans is a `NoHistoryError` and GraphQL errors are inconclusive;
either way another source can help.

## Testing

Set `AUSTRIAN_POST_TRACKING_NUMBER`, and optionally a Hermes Austria number as
`AUSTRIAN_POST_HERMES_NUMBER`, outside the repository, then run
`npm run test:carriers:live -- carriers/austrian-post`.
