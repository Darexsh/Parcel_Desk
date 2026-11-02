# M&P

M&P, formerly Muller & Phipps, is a Pakistani courier and logistics company. It carries
documents, parcels and cash-on-delivery orders between its stations across Pakistan. Tracked
through its tracker's page.

## How it works

1. `direct`: one `GET https://www.mulphilog.com/tracking/{number}`, the page the search boxes on
   mulphilog.com open. The server renders the consignment's scans into it. It needs no cookie,
   token, captcha, phone digits or browser.
2. `retry`: one more read when M&P cannot be reached or does not answer in time.

- An unknown number is HTTP 200 with the notice "No tracking record found with the provided
  consignment number." A 404 or a redirect is a moved route.
- The page's form shows the number the page was opened for, which must be the whole number
  asked. The tracker matches whole numbers only.
- The site's quote form draws its own captcha on every page, so only a page without the
  tracker's result is read as a block.
- Recognition makes the same request.

## Notes

- Each scan has a date and a twelve-hour clock to the minute without an offset. M&P's network
  is in Pakistan, which keeps one offset without daylight saving, so every clock is read in
  Karachi time.
- A scan shows a status label, the city and a sentence. The sentence is the description and
  the label, such as `Out-for-Delivery`, is the provider code; the label stages the scan. The
  earlier page's labels and details, such as `Booking` and `Shipment is booked.`, stay in the
  map.
- `Arrived at OPS Facility` is the origin hub taking the consignment in, and reads as accepted.
- A delivery's sentence goes on to name who received the parcel, which is cut. Phone numbers
  and amounts to collect are taken out of every sentence. A failed attempt's reason is
  followed by a line on the next try; the two read as one sentence.
- The booking date, the shipper, the consignee, their cities and the order reference above the
  scans are not kept.

## Limitations

- The page names no service, weight, estimate or proof of delivery.
- Older consignments drop out of the tracker and then answer as unknown. Returns and
  consignments sent abroad have not been seen on the current page.

## Numbers

M&P consignment numbers seen in archived lookups on its tracker are fifteen or twelve digits,
and customer reviews give twelve- and fifteen-digit ones; the adapter takes twelve to fifteen
digits. Digit runs of these lengths are printed by many carriers and no known prefix or check
digit sets M&P apart, so no rule claims them. Recognition can tell a known number from an
unknown one, but without a rule offering M&P it is not asked; a caller names the carrier or
pastes a tracking page link. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The search boxes on mulphilog.com open one consignment at `/tracking/` followed by the number.
The library reads the number from that address.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Recognition stays on direct HTTP. Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.

## Testing

`npm run test:carriers:live -- carriers/m-and-p`, with `M_AND_P_TRACKING_NUMBER` and optionally
`M_AND_P_UNKNOWN_NUMBER` set outside the repository.
