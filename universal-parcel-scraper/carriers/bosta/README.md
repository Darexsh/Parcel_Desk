# Bosta

Bosta is an e-commerce courier in Egypt and Saudi Arabia: merchants book their orders, which
Bosta picks up, delivers and collects cash for. Tracked through the lookup its tracking page
makes.

## How it works

1. `direct`: one `GET https://tracking.bosta.co/shipments/track/{number}?lang=en` with the
   header `X-Requested-By: Bosta`, as the tracking page on `bosta.co` sends it for the number in
   its address. It needs no cookie, token, key or browser. The JSON reply has the order's type,
   its current state, the scans with their state codes and English wording, the promised day and
   the destination country.
2. `retry`: one more try when the request fails to reach the service or hangs. The first try gets
   half of the budget.

- An unknown number is HTTP 404 with `Invalid tracking number!`. Another 404, a redirect or a
  firewall page is not.
- The service allows ten lookups per address in five minutes, then answers HTTP 429 with a
  five-minute wait.
- The service answers some numbers with another shipment, so a reply counts only when its
  `TrackingNumber` is the number asked.
- A draft order the merchant has not confirmed answers with `isDraftOrder` and "Order is under
  review". It is not a shipment and has no history.
- An older shipment can come without scans; its current state is returned as a summary.
- Saudi shipments come from the same service; the page for Saudi Arabia makes the same lookup.
- Recognition makes the same request.

## Notes

- Scan and state times are UTC instants and are returned as given. The promised day is read in
  the destination's zone, Cairo or Riyadh.
- Without the `X-Requested-By` header the service answers in an older shape, with hub names but
  bare state names, no return wording, no order type and no country. The page's shape is read
  for those, so scans have no location.
- The state codes are those of Bosta's webhook documentation. Some come on both legs of a
  return: a picked-up order (41) is out for delivery on the way to the customer and out for
  return on the way back, and the warehouse and hub states come on both. The page words those
  scans for their leg, so the wording is read first. An order of type `RTO` has turned into a
  return, which the page shows as such before the scans do, so it is returned. A final state,
  such as delivered, returned, terminated, cancelled or lost, decides the stage whatever the
  scans say.
- The estimate follows the page: none before the merchant hands the order over, the day the
  courier went out while the order is out, otherwise the promised day, up to the next working
  day after it when the reply gives one.
- The merchant's id and the delivery window that comes with an out-for-delivery scan are not
  kept. The page shows the address, the cash to collect and the courier only after a code sent
  to the customer's phone; the adapter does not read them.

## Limitations

- No locations, weight, service, sender, recipient or proof of delivery.

## Numbers

Bosta shipment numbers are plain digit runs without a leading zero: seven and eight digits in
archived lookups on its tracker and in the sample numbers of Bosta's front-end assessment, and
ten in the tracker's own replies. Its tracking API also answers for shorter draft orders, which
are not shipments. No rule claims these numbers: seven to ten digits are a shape many carriers
print. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

Bosta's tracking page opens one shipment from `shipment-number`, with or without the locale
in the path: `bosta.co/en-eg/tracking-shipments?shipment-number={number}`. Its script builds
that address from the navigation bar's search and looks the number up on load. The former page,
`bosta.co/tracking-shipment/`, took the number as `track_num`.

## Testing

`npm run test:carriers:live -- carriers/bosta`, with `BOSTA_TRACKING_NUMBER` and optionally
`BOSTA_UNKNOWN_NUMBER` set outside the repository. The test makes three lookups, within the
service's limit.
