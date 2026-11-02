# ViaDireta

ViaDireta (Via Directa) is a Portuguese courier for last-mile and scheduled deliveries, on the
mainland and to the islands. Tracked through its tracking page.

## How it works

1. `direct`: one `GET https://www.viadireta.pt/tracking?codigo={number}`, the address the
   page's own form opens, asked in Portuguese. It needs no cookie, token, postcode or browser.
   The server renders the page: a card with the number, a summary and the last update, then the
   movements, newest first, each a wall clock and a wording.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- The page answers every number with HTTP 200, so a 404 or a redirect is a moved route, a 403
  or a firewall page is a challenge, and the form must keep the whole number asked. The card
  must name it too.
- Recognition makes the same request.

## Notes

- A number the page cannot show gets a notice asking to try again later, and a comment beside
  it says the page's API returned an unexpected error. Made-up numbers in both layouts get
  exactly that page, and nothing on it tells an unknown number from a failing lookup, so the
  adapter reads it as inconclusive, never as not found. Recognition therefore only ever learns
  that a number is known.
- Movement clocks are wall clocks to the second with no zone, so they stay `local_time`, and
  consumers fall back on the catalog's Lisbon clock. Of two movements on one clock, the one
  higher on the page is the newer.
- The movements are Portuguese whatever language is asked; only the page around them follows
  it. A movement that ends with `Nova data: dd-mm-yyyy` sets the next delivery day, which the
  newest such movement gives as the expected delivery until the parcel is delivered. The status
  map reads the wording without that day.
- The card's summary and the contact and delivery-change forms are not read.

## Limitations

- No places, instants, codes or proof of delivery.
- Scans for island deliveries carry the same zone-less clocks; the page does not say whether
  they are on the Azores clock.

## Numbers

ViaDireta numbers are VD and twelve digits, or VDVD, the day the label was made as `DDMMYY`,
and six digits. Both rules have high confidence, as no other carrier issues either layout, and
the dated one checks the day and month. The page's form shows VD and ten digits as its example,
which the adapter accepts too, but no rule claims it: Relais Colis prints that layout.

## Links

The tracking page opens one shipment from its `codigo` parameter, and it is read as a link.

## Testing

`npm run test:carriers:live -- carriers/viadireta`, with `VIADIRETA_TRACKING_NUMBER` and
optionally `VIADIRETA_UNKNOWN_NUMBER` set outside the repository.
