# Jeebly

Jeebly is a last-mile and e-commerce courier in the United Arab Emirates. Tracked through the
lookup of its public UAE tracking page.

## How it works

The [tracking page](https://myjeebly.jeebly.com/shipment-tracking/) is a form that submits to
itself with `GET`. It asks for the delivery service as well as the air waybill number: Express,
Scheduled or Moveo. The number does not show its service, so the adapter asks each in turn.

1. `direct`: `GET https://myjeebly.jeebly.com/shipment-tracking/?uae=uae&service_type={service}&awb={number}`
   for Scheduled, then Express, then Moveo, until one has the shipment. The reply is the HTML
   page: the form with the number in its field and the service checked, then the result.
2. `retry`: a lookup that fails to reach the site, or hangs, is made once more. The first gets
   half of the budget. A service that already answered is not asked again.

- No cookie, token, key or browser is needed.
- The page must put the whole number back in its field and check the service asked, and the
  result must name the number as its reference.
- "No Shipment Found" under every service is a missing shipment. A form without a result, which
  the page shows for a service it does not offer, is a schema error. A block page, even with HTTP
  200, is a challenge, and so is a redirect to the sign-in page. A 404, a 410 or another redirect
  is a moved route.
- Recognition makes the same lookups.

## Notes

- Every public number the tracker knows is under Scheduled, the form's default, so it is asked
  first and a known number costs one request. An unknown number costs three.
- Each scan has a day, a clock to the minute, a status name and a line. The status name, such as
  `Out For Delivery`, is the scan's provider code and stages it; the line, such as "Consignment
  is out for delivery", is its description. The names are those of Jeebly's webhooks. An edit of
  the order and a new delivery date move nothing.
- The page names no zone. Jeebly's webhooks send their scans in UTC, and nothing shows whether
  the page converts them to the UAE's clock, so the clocks stay `local_time`.
- The tracker does not strip spaces: a number sent after a space is not found. The adapter sends
  the number without them.
- A line loses phone numbers. The pickup and drop-off cards, which hold the sender's and the
  recipient's names and addresses, are not read, nor are the payment type, the item type, the
  piece count and the weight, which has no unit. The package card's `Delivery`, such as "next
  day", is the service name.

## Limitations

- No scan locations, estimate or proof of delivery, and no clock with an offset.
- No Express or Moveo shipment has been seen; their pages are read as Scheduled's are.

## Numbers

Jeebly air waybill numbers start with `JB`. Archived lookups on Jeebly's tracker show `JB`
followed by seven digits, and `jeebly-1` claims that layout with low confidence: a two-letter
prefix and seven digits is a common reference shape. Jeebly's API and webhook documentation
shows six digits after `JB` or `JBP`. No rule claims those documentation layouts, but the
adapter takes them. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

Jeebly's tracking form needs the delivery service as well as the number, so no address opens
one parcel from the number alone. Links to the tracking form and to its result page carry the
number in `awb`.

## Testing

`npm run test:carriers:live -- carriers/jeebly`, with `JEEBLY_TRACKING_NUMBER` and optionally
`JEEBLY_UNKNOWN_NUMBER` set outside the repository.
