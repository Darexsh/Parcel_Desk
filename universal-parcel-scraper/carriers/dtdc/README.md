# DTDC

Tracks shipments available in the official MyDTDC consumer feed.

## How it works

One anonymous GET returns the current state and scan history. The returned
consignment must contain the requested booking reference or waybill. Related
forward and return scans stay on their own legs, and the current state remains
a separate dated snapshot when it is absent from the scan list.

Return booking and movement keep active stages so later progress can be synced.
Only delivery on the return leg completes the return; it does not set a recipient
delivery time.
The stored scan does not keep the status label the parser reads first, so the parcel
app's review (`statusMap`) stages a scan only when its wording is such a label, and
gives a delivery no stage there, since it is not asked by the leg.

## Limitations

Some legacy consignments are unavailable in this feed. Its generic failure
message does not prove that a number is unknown. Recipient details, addresses,
booking information and unlabelled weight values are excluded.

Published legacy references can suggest DTDC without establishing that the
current feed retains their history. Detection keeps that distinction for legacy
waybills of one letter and eight digits: `N` waybills are selected, and the
other letters DTDC's former tracker is known to have answered are only
suggested. `A` waybills are left out: one DTDC reply shows one, and a Day & Ross
sample shares the shape.

DTDC's international consignments, `N` and eight digits, get the feed's generic
failure. DTDC Australia's open tracker, `GET www.dtdcaustralia.com.au/track_order/{number}`,
answers them from DTDC's international system. It matches the whole number in either case
and returns rows with a status, a free-text note and a place. When FedEx or DHL takes the
parcel abroad, a note names that carrier's label number and the partner's scans follow.
The adapter does not ask it: the reply does not repeat the number, the notes carry contact
addresses and staff names, and the clocks name no zone. Deliveries abroad fall in working
hours only when read as UTC.

The tracking page on www.dtdc.com asks `POST /wp-json/custom/v1/domestic/track` and related routes
with an `X-DTDC-Track-Token` header its CAPTCHA check issues; without one they answer HTTP 403
"Security verification failed", so the adapter does not use them.

## Testing

Set `DTDC_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/dtdc/adapter.live.test.ts`.
