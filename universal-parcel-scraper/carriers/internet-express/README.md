# Internet Express

Internet Express is a South African courier. It tracks shipments on a Ship Logic portal, and
the adapter makes the lookup that portal makes.

## How it works

1. `direct`: one `GET https://api.portal.internetexpress.co.za/tracking/shipments` with the
   reference in `tracking_reference` and Internet Express's Ship Logic provider id, `9`, in
   `provider_id`, as the portal sends them. It needs no cookie, token or key. The JSON reply has
   the shipment and its scans, newest first.

- A reference the service does not know is HTTP 404 with the plain text `could not find
  shipment or parcel with reference {number}`, which the portal shows as it is. Only that text
  naming the reference asked is not found; another 404 or a 410 is inconclusive.
- The shipment must belong to provider 9 and carry the reference asked as its waybill
  reference or its six-character short reference.
- There is no recognition: no detection rule claims Internet Express's references.

## Notes

- Scans with `parcel_id` 0 are the shipment's timeline, the one the portal shows; a piece's own
  scans are left out, so one delivered piece does not deliver the shipment. The portal also
  hides operational events, such as a driver accepting a collection, and so does the adapter.
- The current status is the summary's `status`. When that is one of the hidden events, the
  portal shows the newest scan it keeps instead, and so does the adapter.
- A scan's description is its status code in words, with the portal's own labels for driver
  assignments. Each scan's free-text message, which holds driver text notices and staff
  remarks, is not kept.
- Every clock carries its UTC `Z`, so scans are instants.
- A failed collection is still `registered`: the parcel waits at the sender for the next try.
- The service level name is `service_name`. The delivery estimate is not kept: a delivered
  shipment keeps its old window.

## Limitations

- No estimate, piece count or hub names.
- A piece reference (the waybill reference, `/` and the piece number) does not pass input
  validation, so pieces cannot be looked up on their own.

## Numbers

Waybill references are nine letters and digits; the portal answers in capitals whatever case
was typed. Nothing in that shape points to Internet Express, so no rule claims them. The sample
and its source are in [`numbers.json`](numbers.json).

## Links

The portal opens one shipment at `portal.internetexpress.co.za/track?ref={number}`, and the
number is read from that address. The waybill form on the home page posts the number instead.

## Testing

`npm run test:carriers:live -- carriers/internet-express`, with
`INTERNET_EXPRESS_TRACKING_NUMBER` and optionally `INTERNET_EXPRESS_UNKNOWN_NUMBER` set outside
the repository.
