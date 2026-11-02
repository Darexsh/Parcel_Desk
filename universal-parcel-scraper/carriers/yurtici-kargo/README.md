# Yurtiçi Kargo

Tracks Yurtiçi Kargo shipments in Turkey through the services behind the tracker on
yurticikargo.com.

## How it works

The page at `www.yurticikargo.com/tr/online-servisler/gonderi-sorgula?code={number}` reads three
JSON services under `www.yurticikargo.com/service/`, each with `id` and `language` query
parameters. `shipmentstrackingsearch` turns the code into the shipment's id and says whether
the shipment is international. `shipmentstracking` gives the shipment's details by that id, and
`shipmenttrackingmovement` lists the movements of the typed code. The adapter makes the same
requests in English, without a key, cookie or browser. It asks for movements only for a parcel
not yet delivered or returned, as the page does; the service lists none for the others.

A domestic shipment's id is its twelve-digit code, and the details must carry the same id. The
search's notice for a code it does not know, in English or in Turkish, is not found. When the
search knows a code but the details answer that notice, the record has expired, so the answer
is indeterminate. Firewall pages, HTTP errors and malformed replies keep their own failure
kinds. Recognition uses the same lookup.

## Numbers

Shipment codes are twelve digits and international AWB codes sixteen; other inputs are invalid
without a request. Twelve digits are shared by several carriers, so no detection rule claims
them and preflight does not ask this adapter.

## Notes

Movements carry wording without a code. Each names its unit's city and county, which become
the location; a transfer between units names none. A reason, such as why a delivery failed, is
added in brackets. Branch names and phones, the sender, the recipient and whoever took the
parcel are not read.

A delivered or returned parcel's answer is a summary: the shipment date from the details, and
the summary status at the last process time, in the delivery unit's city and county. It is
marked as a summary, so an enabled universal provider with the full history can replace it.
The summary status sets the current stage once the parcel is delivered or returned, and for a
return that has not reached its sender; the newest movement does otherwise. The English
tracker keeps some summary statuses in Turkish.

Clocks are Turkish wall time without an offset, so they stay local, and a movement dated by its
day alone keeps that day. The estimated delivery day
is kept while the parcel moves, unless a movement is newer. A parcel delivered to its branch
for collection names that branch as its pickup point.

## Limitations

International shipments are tracked from an AWB record the adapter does not read, so they are
indeterminate. Delivered and returned parcels have no movement history. The official app's
service needs a per-device token, so it is not used.

## Live test

Set `YURTICI_KARGO_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/yurtici-kargo/adapter.live.test.ts`.
Optionally set `YURTICI_KARGO_UNKNOWN_NUMBER` to check a not-found number.
