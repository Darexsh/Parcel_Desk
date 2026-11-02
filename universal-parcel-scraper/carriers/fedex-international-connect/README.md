# FedEx International Connect

FedEx International Connect (FIC) is FedEx's economy cross-border service, which grew out of P2P
Mailing. It carries a parcel from its hubs in Europe or the United States abroad and hands it to a
partner carrier, usually the destination's post, which delivers it under its own number. FedEx
International Connect Plus is a different service on FedEx Express's network, tracked by FedEx with
FedEx's numbers. The old FedEx Cross Border front door now leads to FedEx's American eCommerce
Connect, so that name is not an alias. The adapter reads FIC's tracker.

## How it works

1. `direct`: `GET https://fictracking.fedex.com/?MyFICNumber={number}` answers with an HTML page
   and no challenge, cookie or session.
2. `retry`: one more read when the first fails to connect or hangs. The first gets half of the
   budget.

- The tracker also looks up a partner's number or a shipper's reference. The adapter asks only for
  an FIC tracking number, and reads only a page whose heading and "FIC Tracking Number" are the
  whole number asked.
- The tracker says it has no record of an unknown or expired number, read as not found. Records
  last about a year. Any other page is a schema failure.

## Notes

- The map stages each event code with the wordings recorded in [statuses.json](statuses.json).
  Code 218 is the shipper's side and names the shipper: "EXPECTED FROM" it is a label, "DEPARTED"
  it is FedEx collecting the parcel.
- Scans give a wall clock and no zone. FIC's own scans are on the clock of the hub that made them.
  They stay in `local_time`, and Node lookups date them on the zone of their place or leg.
- From `RECEIVED BY PARTNER CARRIER` on, the scans without a place are the partner's, on its clock.
  The British hub's London time put a Dutch post's scans for Hungary an hour late, so they are read
  in the destination's zone when it keeps one clock, and otherwise stay local.
- The "View More Tracking" button opens the partner's tracker for the number the page gives as the
  parcel's tracking number. When the catalog lists that site as the partner's own, as Royal Mail's
  or USPS's, the two become `delivery_carrier` and `delivery_tracking_number`. A button to
  PostNord's DirectLink, which carries a post's number for many destinations, names none.
- The destination country, service and weight are read. The shipper's reference and the partner's
  local number are not.

## Limitations

- No sender, recipient, signature or expected delivery.

## Numbers

An FIC tracking number is three letters naming the shipper, four digits, the country the shipper
sends from and eleven digits. FIC's tracker labels it "FIC Tracking Number", and archived lookups
there show it behind many shippers' letters. Starlinks Global labels its parcels the same way, and
neither tracker knows the other's, so the rule is low-confidence and puts FIC first.

## Links

A link to the tracker with `MyFICNumber` opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/fedex-international-connect`, with
`FEDEX_INTERNATIONAL_CONNECT_TRACKING_NUMBER` and optionally
`FEDEX_INTERNATIONAL_CONNECT_UNKNOWN_NUMBER` set outside the repository.
