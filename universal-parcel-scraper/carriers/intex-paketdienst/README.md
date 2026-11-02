# INTEX Paketdienst

INTEX Paketdienst is a German parcel service for valuables and direct deliveries. Tracked
through its own tracker on intex-paketdienst.de.

## How it works

1. `direct`: one `GET https://www.intex-paketdienst.de/sendungsstatus/index.php?sdnr={number}&mid=1`,
   as the tracker's form sends it. It needs no cookie, token, key or browser. The server renders
   the page: a table with the number and the destination, then the scans, oldest first, in
   German.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- An unknown number is HTTP 200 with `Eine Sendung mit der Nummer: … konnte nicht ermittelt
  werden!`, which is not found when it repeats the number asked. A 404 or a redirect is a moved
  route.
- A shipment must be the only one on the page and its `Ihre Sendung Nr.` must be the whole
  number asked. Anything else is inconclusive.
- There is no recognition: no detection rule offers INTEX for a number, so preflight never asks
  it.

## Notes

- The number is sent with the hyphen before its last digit, whether it was typed with it or
  not: the tracker shows the number that way and an archived lookup found a shipment so.
- The website's tracking page frames this tracker, so both read the same page.
- Scan times are wall clocks without a zone, read in Europe/Berlin.
- The rows carry wording only, which stages them. A delivery row has not been seen; its wording
  falls to the shared rules.
- The destination's `D-` prefix gives Germany as the destination country. Its postcode and town
  are the recipient's and are not kept.
- An archived page holds a hidden link to Der Kurier's tracker with another parcel number. Der
  Kurier is not in the catalog, so that number is not kept and no partner is named.
- The not-found page offers to look the same number up at FedEx. That is no hand-off: INTEX
  does not know the number.

## Limitations

- No scan locations, delivery estimate, sender, recipient or service name.
- INTEX drops old shipments, which are then not found.

## Numbers

An archived lookup on the tracker shows a shipment number of seven digits, a hyphen and one more
digit. Without the hyphen it is eight digits, a length several carriers share, so no rule claims
it. The adapter takes both forms; anything else is invalid without a request. The sample and its
source are in [`numbers.json`](numbers.json).

## Links

INTEX's tracking form sends the number as `sdnr` to `intex-paketdienst.de/sendungsstatus/`,
so `intex-paketdienst.de/sendungsstatus/index.php?sdnr={number}&mid=1` opens one shipment.
The home page form sends `sdnr` to `intex-paketdienst.de/website/tracking.html`. The library
reads the number from both.

## Testing

`npm run test:carriers:live -- carriers/intex-paketdienst`, with
`INTEX_PAKETDIENST_TRACKING_NUMBER` and optionally `INTEX_PAKETDIENST_UNKNOWN_NUMBER` set outside
the repository.
