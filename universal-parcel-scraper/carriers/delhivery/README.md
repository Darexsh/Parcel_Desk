# Delhivery

Reads domestic parcel status and scans from the public consumer tracking feed.

## How it works

One GET with the website's Origin and Referer headers returns an identity-bound shipment.
It needs no merchant API token or account. An explicit invalid-or-old waybill response is
not-found; other empty replies remain schema failures.

Shared numeric waybill formats remain suggestions. HTTP recognition asks the same
feed and confirms Delhivery only when its identity-bound result contains shipment activity.

A thirteen- or fourteen-digit waybill is an account's series followed by a counter and a
check digit from 0 to 6, and no series starts with 0. Detection offers Delhivery only for
those, so a DPD parcel number starting with 0 or a number ending in 7, 8 or 9 is not asked
about. Delhivery does not document the check, and some series compute it differently, so
detection bounds only the last digit.

## Notes

Future progress labels are excluded. Current status becomes a snapshot when no scan
reports it at the same instant; its timestamp is never assigned to an undated scan.
Freight (B2B) replies date each reached milestone instead of its scans, and a pickup
milestone can have no scans. Such a milestone becomes an event of its own. Its date has
no year: it takes the year, no more than one before the status date, in which the day
falls on the weekday shown, or else stays as written. The delivered milestone dates the
delivery, since a freight status can date a later proof-of-delivery audit, and the
delivered status then adds no snapshot of its own.
Calendar days and invalid date labels remain unresolved instead of becoming midnight scans.
The returned flow can still be in transit. Its shipment status determines current progress;
return scans retain their leg, and sender delivery does not become recipient delivery.
The parcel app's review (`statusMap`) reads the wording alone, so "Delivered" stays open there,
since the stored scan does not keep its leg.
Scan remarks, recipient information, coordinates, references and phone fields are excluded.

## Limitations

Anonymous tracking can expose only the latest undated scan; the website asks for login to
show more detail. It names no sender. Displayed delivery periods are prose, so the adapter
does not convert them into an exact delivery estimate. Freight waybills come through the
same feed. A freight LR number is another identifier, which the website first resolves to
its waybill through a separate B2B service; the adapter accepts waybills only.

## Testing

`npm run test:carriers:live -- carriers/delhivery`. Set
`DELHIVERY_TRACKING_NUMBER` to check an authorized real parcel.
