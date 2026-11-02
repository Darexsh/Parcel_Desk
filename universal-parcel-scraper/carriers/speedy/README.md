# Speedy

Tracks Speedy shipments in Bulgaria, including legs Speedy hands to partners abroad, through
the anonymous endpoint behind MySpeedy's public tracker.

## How it works

The [MySpeedy tracker](https://myspeedy.speedy.bg/pub/tracking/) reads a shipment with
`GET https://myspeedy.speedy.bg/rest/public/track?id=...&language=en`, and the adapter sends
that one request. No account, cookie, key or browser is needed. The Speedy app points at the
same host. www.speedy.bg sits behind a Cloudflare challenge, and Speedy's REST API at
api.speedy.bg needs a customer account, so neither is used.

The reply must name the whole requested number. For a number it does not know, the endpoint
answers HTTP 404 with MySpeedy's "the requested resource does not exist" page, which the
tracker shows as an invalid number, so that page is not found. Other 404s, blocked pages,
HTTP errors and malformed replies keep their own failure kinds. Recognition uses the same
lookup.

## Numbers

Speedy shipment and parcel numbers are eleven digits, so other inputs are invalid without a
request. Speedy's API documentation and public reports show them starting with 6, mostly 63.
Eleven digits are shared with several carriers, so both rules are low confidence. `speedy-1`
prefers Speedy for the 63 series, which no other carrier's public numbers show, so recognition
asks it first wherever the lookup comes from. `speedy-2` only suggests Speedy for the rest of
the 6 series, where GLS, PPL and Japan Post numbers appear too: recognition asks it first when
the lookup's country is Bulgaria or Romania. It leaves out 600, the series of Palletways'
consignment IDs.

## Notes

Each scan carries an operation code. The adapter keeps the reply's English wording and the
code, and sets the stage from the code list in Speedy's
[API documentation](https://api.speedy.bg/api/docs/). A reply without scans falls back to the
shipment's phase. Scan clocks carry their own offset. A place drops the site type Speedy writes
before the town, `gr.` in Bulgaria and `or.` in Romania, and a partner's numeric site code.

The estimate is the expected delivery day on the shipment-data scan, kept while the shipment is
on its way. The pickup point is the name of the office or locker Speedy prepared the shipment
at, once it waits there or was collected from it; contents checks at the counter do not move
it. When Speedy hands the receiving leg to ACS, the adapter names ACS and its number so the
partner can be asked about a ten-digit voucher. The office address, the masked recipient, the proof-of-delivery link and
the return waybill number are dropped.

## Limitations

A delivery postponed to a later day and the contents-check scans have no stage: the codes do
not say whether a courier tried or the parcel moved. A route MySpeedy removed would answer the
same 404 page as an unknown number. Partners other than ACS are not named.

## Links

Speedy's tracking page reads the number from `shipmentNumber` at
`www.speedy.bg/{language}/track-shipment`, as its older `begin.php` page did, and MySpeedy's
from its path at `myspeedy.speedy.bg/pub/tracking/{number}`. Such links name Speedy.

## Live test

Set `SPEEDY_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/speedy/adapter.live.test.ts`.
Optionally set `SPEEDY_UNKNOWN_NUMBER` to check a not-found shipment number.
