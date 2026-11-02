# No Limit

No Limit is a Polish logistics company that delivers large and heavy goods to the door, such
as the furniture and appliances online shops and marketplaces sell. Tracked through the form of
its English tracking page.

## How it works

1. `direct`: `GET https://follow.nolimit.pl/Defaulteng.aspx`, then a `POST` of its ASP.NET form
   back to the same address, as its search button sends it: the page's hidden fields, the
   shipment-number option and the number with its slashes, with the cookies the page set. It
   needs no token, key or browser. The answer is the page again with the shipment's details and
   a table of statuses, oldest first.
2. `retry`: both requests once more when one fails to reach the site or hangs. The first try
   gets half of the budget, so the retry fits in the rest.

- A number the tracker does not know gets the label `Shipment not found`, read as not found
  when the form's field holds the number asked.
- The page answers every number with HTTP 200, so a redirect or a 404 is a moved route, and a
  firewall page or a 403 is a challenge.
- The label must name the whole number asked.
- Recognition makes the same requests.

## Notes

- The English page is read: it words the statuses in English. The Polish page's wordings for
  the same statuses are recorded and mapped too.
- The site's firewall adds its own hidden fields to the form; they are posted back with
  ASP.NET's.
- A warehouse status comes both after collection and at the delivering branch, so it is in
  transit rather than an acceptance that a later warehouse would repeat.
- A branch is named `LOG_` and its town; the town is kept as the location.
- Status clocks are wall clocks to the minute with no zone, so they stay `local_time`.
- The shipment's references, loading and unloading places and parcel count are not read.

## Limitations

- No instants, scan codes, expected delivery or proof of delivery.
- Only shipment numbers are looked up. The form also takes a client order number, a parcel
  number and other references, which no public sample shows.

## Numbers

A shipment number is P and a serial, L and the branch's three letters, and the year, printed
with slashes: `P/1234/LABC/2026`. The form finds it only with its slashes. Normalization drops
them, since the letters and digits read the same without them, and the adapter puts them back.
Reviewers also quote ten- and sixteen-digit numbers, which the form did not find as client
order numbers; no rule claims them.

## Links

The tracking page takes the number only in its form, so no address opens one shipment.

## Testing

`npm run test:carriers:live -- carriers/no-limit`, with `NO_LIMIT_TRACKING_NUMBER` and
optionally `NO_LIMIT_UNKNOWN_NUMBER` set outside the repository.
