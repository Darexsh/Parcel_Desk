# Posta Kenya

Tracks Posta Kenya items, letters, parcels and EMS, its own and those other posts send to Kenya,
through the form of the Postal Corporation of Kenya's tracking page.

## How it works

The [tracking page](https://postglobal.posta.co.ke/postglobaltrack/Track.aspx) is an ASP.NET form.
One lookup takes three requests, as a visitor's browser makes them:

1. `direct`: a `GET` of the tracking page renders the form and its view state. A `POST` back to
   the page sends that state with the code in `txtID`, as pressing Enter in the field does. The
   answer is the form again, with the code in its field and a script: an alert that the tracker
   has no information for the code, or a popup opening `TrackResult.aspx?type=I`. A `GET` of that
   page, with the session cookie the answer set, renders the item's details and scans.
2. `retry`: an attempt that fails to reach the tracker, or hangs, is made once more in a new
   session within the budget. The first gets half of the budget.

- No account, key, token or browser is needed. Only the session cookie is kept, and none outlives
  the lookup. Failures carry no request or response details, as they hold that cookie.
- The answer must echo the whole requested code, and the result page must name it as its
  shipment ID, which the tracker stores in upper or lower case.
- The alert "No information available for this shipment" is the only missing item. A result page
  whose session holds no lookup, or an answer that opened no session, is inconclusive. A block page,
  even with HTTP 200, is a challenge, a 429 a rate limit and a 503 maintenance. ASP.NET's error
  page, another notice, a form without its state or a page without the result's table is a schema
  error, and a 404, a 410 or a redirect a moved route.
- The form takes several seconds to answer for an item the tracker holds, so the adapter's default
  budget is 30 seconds.

## Notes

- Scans are listed oldest first under a heading for each day, with the time to the minute. A scan
  whose place the page ends with "(Kenya)" is read on Nairobi's clock. The other scans, abroad or
  at a place without a country, which includes Kenyan offices and foreign offices written as a
  number, keep their wall clock.
- A place loses an office written with a digit, a postcode or an office number, and keeps its
  country. The second line of a Kenyan office's place, the office the item came from or was bagged
  to, is not read.
- An event name is followed by the reason an item was held or not delivered and the measure taken.
  The map names each event seen; another falls to the shared wording rules.
- The details' destination gives the destination country. The sender, the addressee, who took
  delivery and their identity document, and the proof of delivery the page offers, are not read.
  The details' delivery date repeats the delivery scan's clock.
- Recognition is not declared: the lookup tells a known item from an unknown one, but it takes
  several seconds for an item the tracker holds, longer than recognition's budget, so no
  detection rule offers Posta Kenya for a number.

## Limitations

- No ETA, weight, service or event code, and no clock with an offset.
- The adapter takes only S10 codes with a valid check digit.

## Numbers

The Postal Corporation of Kenya tracks letters, parcels and EMS items by UPU S10 numbers ending
in `KE`, and mail from abroad by the sending post's number. Generic postal detection handles these
numbers, so no rule for Posta Kenya claims them. Mail from abroad reaches Posta Kenya when a caller
names it, a provider names it, or a result gives Kenya as the destination of an S10 item. The samples
and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page shows the result in a popup and has no address for one item.

## Testing

`npm run test:carriers:live -- carriers/posta-kenya`, with `POSTA_KENYA_TRACKING_NUMBER` set
outside the repository. Optionally set `POSTA_KENYA_INBOUND_NUMBER` to an item sent to Kenya from
abroad, and `POSTA_KENYA_UNKNOWN_NUMBER` to a code the tracker has no information for.
