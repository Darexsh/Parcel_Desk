# TCS

TCS is Pakistan's largest courier. It carries documents and parcels between its stations across
the country, delivers to the door and sends shipments abroad. Tracked through the lookup its
tracking page makes.

## How it works

1. `direct`: one `POST https://www.tcsexpress.com/apibridge` with the body
   `{"body":{"url":"trackapinew","type":"GET","headers":{},"payload":{},"param":"consignee={number}"}}`,
   as the tracking page's script builds it. The site's bridge forwards it to TCS's tracking
   service. It needs no cookie, token, key or browser. The JSON reply holds the booking
   details, the delivery records and the checkpoints, both newest first, and a summary.

- An unknown number is HTTP 200 with empty lists and the summary `No Data Found/Invalid CN`. A
  404 or a redirect is a moved route, and a 400 a request the bridge no longer takes.
- The bridge relays a refusal of the tracking service as `isSuccess: false` with its status.
- The booking details and every row name their consignment, which must be the one asked. The
  number is read as typed: a leading zero names another consignment.
- Recognition makes the same request.

## Notes

- Clocks are a weekday, a date and a time to the minute without an offset. Pakistan has one
  zone without daylight saving, so a consignment whose origin and destination country are both
  Pakistan has its clocks read in Karachi time. An international consignment may carry scans
  from abroad, and the reply does not say where each was made, so its clocks stay `local_time`.
- A checkpoint's description is TCS's wording, and the wording stages it. The same field names
  the station on facility and pickup scans and who took the parcel on a delivery, so it is the
  location only on the first.
- The newest delivery record is what the page shows as the current status. Its code `OK`
  decides a delivery and gives the delivery time, over a checkpoint logged after it. Attempt
  records repeat checkpoints in other words, so they are not events.
- A consignment listed without checkpoints is a summary of its newest delivery record, else of
  the summary's status line, such as `Your shipment is in Transit`. The summary's other lines
  greet, give TCS's contact numbers or name who signed.
- The expected delivery date comes from the summary's `Expected Delivery Date` line, which TCS
  writes before the delivery round.
- The shipper's and consignee's names, the signatory and the merchant's reference in the reply
  are not kept. The origin and destination stations are not kept either.

## Limitations

- The reply names no service, weight or piece count.
- Older consignments drop out of the tracker and then answer as unknown.

## Numbers

TCS consignment numbers seen in archived lookups on its tracker and in customer reviews are
eleven, twelve or fourteen digits; the adapter takes eleven to fourteen. Digit runs of these
lengths are printed by many carriers and no known prefix or check digit sets TCS apart, so no
rule claims them; a caller names the carrier or pastes a tracking page link.

## Links

The search box on tcsexpress.com opens one consignment at `/track/` followed by the number. The
library reads the number from that address.

## Testing

`npm run test:carriers:live -- carriers/tcs-pakistan`, with `TCS_PAKISTAN_TRACKING_NUMBER` and
optionally `TCS_PAKISTAN_UNKNOWN_NUMBER` set outside the repository.
