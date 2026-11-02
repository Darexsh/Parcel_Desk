# Global Delivery Network

Global Delivery Network (GDN), based in Kentucky, sends mail and online orders from the United
States abroad, clears them through customs and hands them to carriers there, such as DHL and NZ
Post. Its site is gdnparcel.com. Tracked through its public tracker page.

## How it works

`direct`: one anonymous `GET https://pds.gdnparcel.com/pds_tracking.asp?track={number}`. The page
holds the parcel number, the recipient's address, a partner's reference and a table of scans,
newest first. The parcel number on the page must be the one asked.

- A number the tracker does not know gets a page that says it is "Unable to locate the selected
  Package.", which is not found. A page with neither that nor the parcel is a changed page.
- The scans relay GDN's partners beside its own rows, as wording without codes. [status.ts](status.ts)
  stages GDN's own wording; the shared rules read the rest. A partner taking the parcel on the way,
  such as "Handed over to NZ Post", is in transit.
- The scans give a wall clock without a zone, and a place as a town and a country code
  ("AUCKLAND - NZ"), read as "AUCKLAND, NZ". A scan without a place takes its neighbours' zone.
- The destination is the address's country. The recipient, the address, the weight and the
  partner's reference are not kept.

## Limitations

- The partners' rows carry the same clocks every day, 10:00 and 12:01, which stand for their day;
  they are kept as the page shows them.
- No hand-off: the page names the partner only in a scan's wording, and its reference is not one
  the partner's own tracker was seen to take.

## Numbers

Its tracker shows twelve-digit numbers. Many carriers print twelve digits, so there is no rule,
and the adapter takes twelve digits only. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

Tracking links carry the number as `track` on the tracker.

## Testing

`npm run test:carriers:live -- carriers/global-delivery-network`, with `GDN_TRACKING_NUMBER` set
outside the repository to check a real parcel.
