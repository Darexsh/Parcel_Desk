# Liccardi Express Courier

F.lli Liccardi is a courier from the Naples area with branches across Italy. Tracked through the
lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://operativo.liccarditrasporti.com/ope/rest/tracking/{number}`, the
   lookup the tracking page on `my.liccarditrasporti.com` makes for the number in its address.
   It needs no cookie, token, key or browser, but the service refuses a request that does not
   name the tracking page as its `Referer`, so the adapter sends it. The JSON reply has the
   shipment's summary, its parcels with their scans and its planned delivery day.
2. `retry`: a lookup that fails to reach the service, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- An unknown number is HTTP 404 with the message `Shipment not found`. Any other 404, a 410 or
  a redirect is a moved route.
- The tracking page sits behind SafeLine, a firewall whose browser check (HTTP 468) a plain
  HTTP client cannot pass. The lookup's host does not check; its check, or any other, is a
  challenge.
- The service finds a shipment by its own seven or eight digits (`ldv`) or by its label's
  thirteen (`courierLdv`). The reply must give back the whole number asked; one for a number
  that only starts the same is inconclusive.
- No recognition: no detection rule offers Liccardi's numbers, so preflight never asks it.

## Notes

- Scan times are UTC instants, which the page shows in the visitor's zone. They are returned at
  Italy's offset. The pickup events in the same reply carry Italy's offset and agree with them.
- Each parcel of a shipment has its own scans, which mostly repeat the others' a second or two
  apart. The history keeps a scan once per branch and code within a minute. The shipment is
  delivered when every parcel is; until then it takes the newest scan of a parcel still on its
  way.
- The `codEsito` stages a scan. The map covers the tracker's own list of event codes
  (`/ope/rest/codiciEsiti`) and follows the page's script, which files them under five progress
  steps, apart from the steps that hide a pickup point, a return or a failed delivery: the page
  counts a locker as delivered and a return to the sender as in delivery. Reasons the driver
  gives for not delivering that day, such as a closed shop, bad weather or a broken-down van,
  are failed attempts. Codes that move nothing or do not say which way the parcel went have no
  stage.
- The estimate is the delivery day the page shows over the history when the reply has one, else
  the planned day as last updated, else the first planned. A delivered or returned shipment has
  none.
- When the reply names another courier and its waybill, which the page shows as that courier's
  lettera di vettura, the waybill becomes the delivery number. The reply's courier codes are
  not known, so the number's own detection decides whether another carrier is asked.
- The drivers' names and positions, scan notes, the recipient's town, province and postcode, the
  sender's references, the proof of delivery, the shipment's internal progress codes and the
  pickup the parcel came in, which lists every parcel of that pickup, are not kept.

## Limitations

- No weight, service name, sender or recipient.

## Numbers

Liccardi's help page says its tracking number is seven digits or starts with `66`. Shipment
numbers have since reached eight digits. A label's thirteen digits are `660`, the shipment number
on eight digits and two more. Complaints and reviews quote both. Five carriers already match
thirteen digits, and seven and eight digits are shared by many more, so detection leaves
Liccardi's numbers unclaimed. The adapter asks only for those three shapes. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The tracker on `my.liccarditrasporti.com/segui` reads the number from `?ldv=` and searches
for it when the page opens, so `my.liccarditrasporti.com/segui?ldv={number}` opens one
shipment. The library reads the number from that address.

## Testing

`npm run test:carriers:live -- carriers/liccardi`, with `LICCARDI_TRACKING_NUMBER` and
optionally `LICCARDI_UNKNOWN_NUMBER` set outside the repository.
