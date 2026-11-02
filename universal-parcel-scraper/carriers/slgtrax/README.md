# SLGTrax

SLGTrax, formerly Trax, is a Pakistani courier that carries cash-on-delivery and other parcels
for online shops between cities across Pakistan. Tracked through the lookup its tracking box
on slgtrax.com makes.

## How it works

1. `direct`: one `GET https://sonic.pk/api/shipment/track/consignee/public?tracking_number={number}`,
   the request slgtrax.com's tracking box sends. It needs no cookie, token, captcha or browser.
   The JSON reply has the shipment and its scans, newest first.
2. `retry`: one more read when sonic.pk cannot be reached or does not answer in time. It drops
   connections from some networks.

- An unknown number is HTTP 200 with `status` 0, "Error(s) in Input", and the number listed
  under `errors`. Trax answers any number it has no shipment under that way, so only that list
  holding the number asked reads as not found. A 404 or a redirect is a moved route.
- The shipment must carry the whole number asked.
- The tracking page on sonic.pk posts the number to `/tracking/track` with a session cookie and
  the page's form token. Its reply has the same scans with second-precision wall clocks but no
  reasons, so the adapter reads slgtrax.com's lookup instead, in one request.
- Recognition makes the same request.

## Notes

- Each scan's `date_time` is the Karachi wall clock to the minute, which the pages show, and
  `timestamp` is the same instant in Unix seconds. Trax's network is in Pakistan, which keeps
  one offset without daylight saving, so scans are instants at +05:00, to the second when
  `timestamp` falls in the minute shown and to the minute otherwise.
- A scan's status, such as `Shipment - Out for Delivery`, is the provider code and stages it.
  The former trax.pk tracker's statuses, such as `Parcel Recieved Office` and the return steps,
  stay in the map; its billing lines, `Payment Done` and `Charges Deducted`, move no parcel and
  have no stage.
- `Shipment - Rider Picked` is the pickup from the shipper and reads as accepted, as does
  `Shipment - Arrived at Origin`, the first scan of a parcel dropped at an office.
- A failed attempt's `status_reason` follows its status in the description, without phone
  numbers or amounts to collect.
- Only the number and the scans are kept; the reply's shipper, recipient and order details are
  not.

## Limitations

- Scans name no place, and the reply has no estimate, service or proof of delivery.
- Older parcels drop out of the lookup and then answer as unknown.

## Numbers

Trax tracking numbers are fourteen digits, as every number seen on its trackers is; the adapter
takes nothing else. Fourteen digits are printed by many carriers and no known prefix or check
digit sets Trax apart, so no rule claims them. Recognition can tell a known number from an
unknown one, but without a rule offering SLGTrax it is not asked; a caller names the carrier or
pastes a tracking page link. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page on sonic.pk looks up the number in its address's `tracking_number` as it
opens, which is the link the library builds. Archived addresses also carry the number in
`tracking_number` on sonic.pk's `/cod/tracking` and in `parcel_list` on the former trax.pk
tracker, and slgtrax.com opens its tracking box when an address has `tracking_number`. The
library reads the number from these.

## Testing

`npm run test:carriers:live -- carriers/slgtrax`, with `SLGTRAX_TRACKING_NUMBER` and optionally
`SLGTRAX_UNKNOWN_NUMBER` set outside the repository.
