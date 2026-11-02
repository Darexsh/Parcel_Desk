# HAL Express

HAL Express, the express service of Houng Ah Loun Logistics, carries parcels between its
branches in Laos and to the border with neighbouring countries. Recipients collect parcels at
the destination branch. Tracked through the lookup its parcel page makes.

## How it works

1. `direct`: one `GET https://hal.hal-logistics.la/api/v1/orders/tracking/{number}`, as
   `halexpress.la/parcel/{number}` makes it. It needs no cookie, token, key or browser. The
   JSON reply has the bill's summary and its scans, oldest first.
2. `retry`: the same request once more after a network failure or timeout. The first try gets
   half of the budget.

- An unknown bill is HTTP 404 with the message `No provided shipment bill number match our
  records`, which the page reports as not found. Any other 404 or a redirect is a moved route.
- The lookup matches the whole bill, in either case. The bill in the reply must be the number
  asked.
- Recognition makes the same request. No detection rule offers HAL Express, so recognition is
  not asked until one does.

## Notes

- Each scan's `date` is a wall clock to the second with no zone. HAL works in Laos, but nothing
  in the reply ties the clocks to Lao time, so they stay `local_time`.
- `delivery_state` stages each scan. The reply names code 5 `Delivered`, but its message asks
  the recipient to collect the parcel at the destination branch before a date, after which it
  goes back; the page labels it arrived at destination. Code 6 is the collection.
- Code 11 sends the parcel back to the branch it came from. The scans after it are the return
  leg, and the arrival and collection at that branch are the return. The summary's own status
  still reads as a delivery, so the adapter reads the history instead.
- A message loses what follows ` - `, the staff member who scanned the parcel and a phone number,
  unless it names a branch, a branch's warehouse or a sorting centre. Other phone numbers go too.
- The summary's sender and recipient names, the recipient's partly masked phone number, the
  branches and their phone numbers, the parcel's category, size and weight, and the charges are
  not kept. The page shows most of them only to the sender or recipient once logged in.

## Limitations

- No expected delivery and no delivery time as an instant.
- The page's search box also takes a phone number, which needs a login. The adapter takes bill
  numbers only.

## Numbers

The bill number starts with the sending province's three-letter code, such as `VTE` or `SVT`,
followed by eleven digits. The carrier's web app gives one as its example. No rule claims the
shape: public examples are few, and other Lao carriers print similar branch-coded bills. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

`halexpress.la/parcel/` followed by the bill number opens one parcel; the carrier's web app
builds this address when it shares a parcel.

## Testing

`npm run test:carriers:live -- carriers/houng-ah-loun`, with `HOUNG_AH_LOUN_TRACKING_NUMBER` and
optionally `HOUNG_AH_LOUN_UNKNOWN_NUMBER` set outside the repository.
