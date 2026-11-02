# Pathao Courier

Pathao Courier is the parcel delivery arm of Pathao, delivering online orders for merchants
across Bangladesh. Tracked through the lookup its public tracking page makes.

## How it works

1. `direct`: one `POST https://merchant.pathao.com/api/v1/user/tracking` with the body
   `{"consignment_id":"{number}"}`, as the public tracking page sends it for the ID in its
   address. It needs no cookie, token, key or browser. The JSON reply has the order's summary,
   the state of the page's progress rail and the scans, oldest first, each filed under a step
   such as `Picked` or `Ready For Delivery`.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- An unknown ID is HTTP 404 with `{"type":"error","code":404,"message":"Invalid consignment"}`,
  which the page reports as no data found. Any other 404 or a redirect is a moved route.
- An ID the service's own form check refuses is a 422, which is invalid input.
- A browser check from a CDN or firewall in place of the reply is a challenge.
- The order must name the ID asked.
- Recognition makes the same request.

## Notes

- Tracking links can carry the recipient's phone number beside the ID, and the page then sends
  it as `phone_no`, which adds the recipient's name, phone number and address and the
  merchant's name to the reply. The history is the same without it, so the adapter sends the
  ID alone.
- Scan clocks are wall clocks in Bangladesh, which keeps one zone, so scans are returned at
  `+06:00`.
- A scan's step stages it. The delivery hub's step, `Ready For Delivery`, holds both the
  arrival at the hub and the rider's assignment, which the wording tells apart and which is out
  for delivery. A hold at the delivery hub is an exception. The rail's state decides a delivery
  or a return; otherwise the newest staged scan does.
- Riders' names, staff codes and phone numbers are taken out of the wording. Staff notes under a
  scan are free text that can name people, so they are not kept, nor are the rider, the
  contents, the amounts to collect or the delivery hub's position.
- The reply's delivery estimate, a window of days, is kept while the parcel is on its way,
  unless it ended before the newest scan's day. The page itself does not show it.

## Limitations

- No scan locations other than the hub names in the wording, no weight and no proof of
  delivery.
- Pathao's parcels in Nepal use another site and are not covered.

## Numbers

Pathao consignment IDs have fourteen characters: `D`, a letter, the creation date as day, month
and two-digit year, and six letters and digits. Archived replies of Pathao's tracking service
and its developer documentation show them, and `pathao-courier-1` claims the layout. The
adapter asks only for IDs of that layout. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking form on pathao.com opens Pathao's merchant site with the ID as `consignment_id`,
so `merchant.pathao.com/public-tracking?consignment_id={number}` opens one parcel. Links to
`merchant.pathao.com/tracking` carry the same parameter next to the recipient's phone number;
only the ID is read.

## Testing

`npm run test:carriers:live -- carriers/pathao-courier`, with `PATHAO_COURIER_TRACKING_NUMBER`
and optionally `PATHAO_COURIER_UNKNOWN_NUMBER` set outside the repository.
