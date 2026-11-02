# ACS Courier

Tracks ACS Courier parcels in Greece and Cyprus through the search API behind ACS's own public
shipment search.

## How it works

ACS's Greek and Cypriot sites mount the same tracker, which asks
`https://api.acscourier.net/api/parcels/search/{number}`. The API wants the key the tracker's
page carries in its `#app-root` element as `publicToken`, sent as `X-Encrypted-Key`, and the
site's `Origin`. The adapter loads the [Cypriot English tracker](https://cyp.acscourier.net/en/quick-access/non-registered-users/track-and-trace/)
for the key, keeps it for a few minutes, and sends one GET per lookup. No account, cookie or
browser is needed. The page loads reCAPTCHA, but the parcel search does not send its token.

The key lives about six minutes. The API refuses an expired one with HTTP 406, as it refuses a
missing one; the `refresh` step then loads the page for a new key and asks once more. A fresh
key it refuses is a transport failure. Without the site's `Origin`, the API answers HTTP 404, so
a 404 is a refused request, not a missing parcel.

The reply must hold exactly one parcel with the whole requested number. ACS answers every
number; one it does not know comes back without status or scans and with a "shipment not
found" note, which is not found. Blocked pages, HTTP errors and malformed replies keep their
own failure kinds. Recognition uses the same lookup.

## Numbers

ACS numbers are ten digits, as Trustpilot reviews and an aggregator page show, so other inputs
are invalid without a request. On every number seen, the last digit is the first
nine modulo 7, as on DHL Express waybills and Geniki Taxydromiki vouchers; the adapter does not
enforce it. Ten digits are shared with several carriers, so `acs-courier-1` only suggests ACS
for ten plain digits whose check holds. DHL Express's waybills carry the same check, so for a
lookup from Greece or Cyprus recognition asks ACS right after DHL Express, and a number both
know stays a choice: the check digit backs neither. Speedy and DPD Romania name ACS and its
number when they hand it the receiving leg, as for parcels to Cyprus; ACS is asked only about a
ten-digit one.

## Notes

The adapter sends the Cypriot site's `X-Country: CY`, which brings every scan with its branch.
The Greek site's `GR` brings a shortened history of five milestones instead, some dated by day
only. `Accept-Language: en-US` gives English wording and Latin place names. The parser also
reads the shortened history, staging its milestones by their ids.

The parcel's summary status settles a delivery, a return or a delivery problem. While it says
the parcel is on its way, the newest scan gives the stage, such as out for delivery or waiting
at a SmartPoint locker. Messages to the recipient keep the stage of the scan before them.

Scan clocks are wall clocks without an offset; the tracker shows them in the viewer's own zone.
They stay local times. A pickup or delivery dated midnight exactly is a day without a clock.
The reply's expected delivery day, which the page does not show, is kept while the parcel
moves and the day has not passed. The pickup point is the SmartPoint's name, once the parcel
waits there or was collected from it.

The reply's notes hold the recipient's name, and each scan's information can hold a masked
signatory or sender name or a delivery problem's reason. The adapter reads the information only
on a failed delivery, as its reason after the scan's wording, and drops any that holds an
asterisk, a digit or an at sign, as a masked name, a phone or an address does. It reads none of
the notes, the recipient, sender, address or branch phone fields, the progress rail or the
summary delivery date.

## Limitations

The scan map comes from parcels within Greece: a scan it does not know, such as one only
Cypriot parcels get, keeps its wording without a stage.

## Live test

Set `ACS_COURIER_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/acs-courier/adapter.live.test.ts`.
Optionally set `ACS_COURIER_UNKNOWN_NUMBER` to check a not-found number.
