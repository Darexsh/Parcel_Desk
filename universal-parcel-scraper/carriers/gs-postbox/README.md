# GS Postbox

GS Postbox is GS Networks' parcel service at GS25 convenience stores in South Korea, formerly
CVSnet. Its half-price service, 반값택배, runs from one GS25 store to another in GS Networks' own
network. Home delivery booked at a store, 국내택배, travels with CJ Logistics under the same
number. Tracked through the page its tracking form opens.

## How it works

1. `direct`: one `GET https://www.cvsnet.co.kr/invoice/tracking.do?invoice_no={number}`, the
   page the tracking form on `cvsnet.co.kr/reservation-inquiry/delivery/` opens. It needs no
   cookie, token, key or browser. The server writes the parcel into the page's script as
   `trackingInfo`: a code, the number, the service, the network that carries the parcel and its
   scans, oldest first.
2. `retry`: a request that fails to reach the site, or hangs, is sent once more. The first try
   gets half of the budget.

- Code 100 is a number the tracker has no record of, which the page reports as unknown: not
  found. Any other code but 200 is a parcel the page cannot show, which is inconclusive. A
  parcel without scans has no history. A 404 or a redirect is a moved route.
- The data must name the number asked.
- Recognition makes the same request.

## Notes

- Each scan's `transTime` is a wall clock to the second, with no zone. GS Networks scans in
  GS25 stores and its own centres, and CJ Logistics in its Korean branches, so their scans are
  read in `Asia/Seoul`, which has no daylight saving. A scan of another network keeps its wall
  clock.
- GS Networks' codes stage its scans. The arrival at the destination store (`C10`) gives the
  pickup point, and the collection there (`C11`) is the delivery.
- For a home delivery the tracker names CJ대한통운 and relays CJ Logistics' scans with their
  codes, which CJ Logistics' map stages; a direct route's branch loses the driver it names. The
  result names CJ Logistics as the delivery carrier, under the same number, so its own tracker
  can confirm the parcel. Another carrier the tracker names is handed over when the catalog
  knows its name.
- The page adds "했습니다." to most wordings when it shows them. The wording is kept as the data
  gives it.
- The sender's and the recipient's names, which the page shows partly masked, their masked
  phones and addresses, and the goods are not read.

## Limitations

- No estimated delivery or weight.
- PICK-UP parcels, which shopping malls send to a GS25 store for collection, are not on this
  tracker. It answers them as unknown, like any number it has no record of.
- CJ Logistics keeps its scans for about three months, so an older home delivery has no
  history.
- The tracking form no longer opens the next-day (내일택배) numbers Dellibox carried, which start
  `4125` or `4325`, because their tracking ended. The adapter asks the tracker about them like
  any other number.

## Numbers

Numbers are digits only: the tracking form takes up to thirteen, and its older form asked for
ten or more. A home delivery has CJ Logistics' waybill. Twelve bare digits are printed by many
carriers, so no rule claims GS Postbox's numbers: a caller names GS Postbox or pastes its link.
Every public number found is a lookup on the tracker, which shows the sender's and the
recipient's partly masked names, so [`numbers.json`](numbers.json) keeps only a made-up one in
the half-price shape.

## Links

The tracking page on `cvsnet.co.kr/reservation-inquiry/delivery/` opens
`cvsnet.co.kr/invoice/tracking.do?invoice_no={number}`, which shows one parcel. The tracking
page also reads `invoice_no` and opens that address at once.

## Testing

`npm run test:carriers:live -- carriers/gs-postbox`, with `GS_POSTBOX_TRACKING_NUMBER` and
optionally `GS_POSTBOX_UNKNOWN_NUMBER` set outside the repository.
