# Lightning Express

Lightning Express is a last-mile delivery company in Richmond Hill, Ontario that delivers
cross-border e-commerce parcels from its distribution centres with its own drivers. Tracked
through the service its tracking page asks.

## How it works

1. `direct`: one `GET https://api.lightningexpressca.com/api/m9310/6907a87b64ac6?waybill_sn={number}`,
   the request the tracking page's script makes from every visitor's browser, with the number
   spaced as the page sends it. It needs no cookie, token, key or browser. The JSON reply holds
   one order: its number, its status code and one wall clock for each milestone it reached.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A number the service holds no order under is HTTP 200 with `{"code":"1","data":null}`, which
  the page reports as not found and the adapter reads as `NotFoundError`. The page shows the
  message of any other code, so another code is inconclusive; a 404 or a redirect is a moved
  route.
- The order must name the whole number asked, whatever its spacing; one for another number is
  inconclusive.

## Notes

- The page's script removes every space from the number, then puts one before its last twelve
  characters and one before its last four. The adapter sends that form. The service also finds
  an order by the unspaced number, and echoes it spaced.
- The reply stamps the label's creation, the collection, the departure for delivery, the
  return to the warehouse and the delivery, each once and with the latest time when a parcel
  reached it twice. The page draws a fixed rail for the current status and leaves out stamps it
  does not fit, such as a delivery before a later return. The adapter turns every stamp into a
  scan, newest first, under the page's English label, and takes the current stage from the
  status code.
- Code 3, returned to warehouse, is a parcel back at the depot after a run that did not deliver
  it: one went out again and was delivered after that stamp, so it is a failed attempt, not a
  return to the sender. The page's script ignores code 1; the newest stamp then decides.
- The clocks are wall clocks without a zone, kept as `local_time`. They are Toronto's: a
  delivery photo's storage time matched its delivery stamp read there.
- The reply also names the client that handed the parcel over, its order number, notes,
  a return reason and the delivery and return photos. None is kept. The page's script has
  places for the recipient's name, phone and address, which the reply does not fill.

## Numbers

The tracking field's example is three letters and two digits, an eight-digit date and a
four-digit sequence. The order list in a screenshot on the business page has three letters
and three digits before the date. The adapter takes three letters and fourteen or fifteen
digits. Only these sources show the layout, so no rule claims it. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The tracking form opens `lightningexpressca.com/track.html?id={number}`; the library reads the
number from the `id` parameter.

## Limitations

- No scan places, estimate, weight, service or delivery partner.
- A parcel that went out or came back twice keeps only its latest departure or return.

## Testing

`npm run test:carriers:live -- carriers/lightning-express`, with
`LIGHTNING_EXPRESS_TRACKING_NUMBER` and optionally `LIGHTNING_EXPRESS_UNKNOWN_NUMBER` set
outside the repository.
