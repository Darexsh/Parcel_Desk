# Timely Titan Express

Timely Titan Express (泰坦国际速递) is a Dutch forwarder that ships online shops' parcels from
the Benelux to China through a warehouse in Hong Kong and a line into mainland China, where the
post delivers them. Tracked through its tracking page.

## How it works

1. `direct`: one `GET https://timelytitan.com/tracking.html?number={number}`. It needs no
   cookie, token, key or browser. The page fills its form with the number searched and shows a
   table of statuses, newest first, each with its clock and its text.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- A number the tracker does not know gets `tracking not found` in place of the table, read as
  not found.
- The page answers every number with HTTP 200, so a redirect or a 404 is a moved route, and a
  firewall page is a challenge.
- The form must hold the whole number asked.
- Recognition makes the same request.

## Notes

- Each text starts with where the row comes from in square brackets: a region, kept as the
  location, or the shop that sent the parcel, which is dropped.
- The rows keep the page's order. Their clocks are wall clocks to the second with no zone, so
  they stay `local_time`, and they are not all on one clock: the shop's first row can show a
  later time than the warehouse row above it.
- The delivering post's rows name the signer, the courier and their phone numbers. The parser
  keeps the brackets that name an office, a city or a day, and drops the others and every
  clause from the first that gives a contact.
- A row `转寄单号:` gives the number the parcel is forwarded under, a postal one. It becomes
  the delivery number when the page gives only one. The page names no carrier for it, so no
  delivery carrier is set.
- The estimate of the day the parcel reaches the next city sets no stage: it is no scan.

## Limitations

- No instants, scan codes, destination, expected delivery or proof of delivery.
- Statuses are in Chinese only.

## Numbers

The one public number seen is TT, thirteen digits and CN. A high rule claims that shape; no
other carrier's rule does.

## Links

`https://timelytitan.com/tracking.html?number={number}` opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/timely-titan`, with `TIMELY_TITAN_TRACKING_NUMBER` and
optionally `TIMELY_TITAN_UNKNOWN_NUMBER` set outside the repository.
