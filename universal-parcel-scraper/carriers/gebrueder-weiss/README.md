# Gebrüder Weiss

Tracks Gebrüder Weiss road, home-delivery, air and sea shipments by number and the sender's or
recipient's postcode, through the public search behind the Track & Trace page on
`my.gw-world.com`.

## How it works

1. `direct`: one `POST https://my.gw-world.com/api/ptnt/public/orders?orderReferenceQuery={number}&shipperConsigneeAddressQuery={postcode}&offset=0&pageSize=20`
   without a body, as the page sends it. It needs no account, key, cookie, CAPTCHA or browser.
2. `retry`: one more try when the request fails to reach Gebrüder Weiss or hangs. The first try
   gets half of the budget.

- The page's second field, Shipper / Consignee, is required. It takes a postcode, town, country
  or name of the sender or recipient; the adapter sends the postcode. The postcode is optional in
  the catalog, so a parcel saved without one is tracked through enabled universal providers; the
  adapter then asks Gebrüder Weiss nothing.
- The search matches the number in several references and answers with a page of shipments.
  The shipment is the one whose order number, request number or one of the sender's references
  is the whole number. A page without one, such as a hit on a partner's reference, and a page
  with two are inconclusive.
- An unknown number, a wrong postcode and a shipment older than the search's window get the
  same empty page: `NotFoundError`.
- The firewall answers a request it rejects with HTTP 200 and a page titled "my-GW
  Maintenance" that says "The requested URL was rejected": `ChallengeError`. Other replies that
  are not JSON are `SchemaError`, and a missing route is a transport failure.
- Failures keep no request details, since the address holds the postcode.
- No recognition: without the postcode the search answers nothing.

## Notes

- Every shipment type comes from the same search. Each status event has a family, an event code
  and usually a reason code; the provider code joins them, as `RDGW/850/009`. The map reads the
  road network's `RDGW` codes, taken from the page's translation file. Other families, such as
  air and sea, go to the shared wording rules. The wording is the short English the service
  sends with each event; the page shows longer wording from its translation file.
- Events the page hides as internal are dropped. The service records many events twice, once at
  the branch and once without a place minutes later; the second is dropped.
- Once a shipment is sent back, every later movement is staged `returned`.
- Clocks are labelled UTC. Scans at branches in Central European time are true instants: they
  sit seconds before the service records them. A branch in another zone sends its wall clock,
  which the service reads as Vienna time, so a Romanian branch's scan lands an hour after its own
  record. Such a clock is read again in the branch country's zone, or kept as a wall clock when
  the country has several zones. A scan without a place keeps the service's instant.
- The estimate is the estimated arrival at the destination, as its day in Vienna, which is what
  the page shows. The actual delivery time and arrivals at a port or airport are not estimates.
  It is cleared once the shipment is delivered or returned.
- The weight in kilograms and the shipment type, under the page's names, are kept. The sender's
  and recipient's postcodes and towns, references, customer numbers, partner references,
  remarks, CO2 figures, documents, the internal German wording and warehouse events are never
  read.

## Numbers

Gebrüder Weiss order numbers have ten digits, and request numbers put a branch's three letters
before one; senders' references take any form. An integration vendor's help article gives one of
two letters, five digits, a hyphen and eight digits. No published format sets these apart from
other carriers' numbers, so no rule claims them and the user picks Gebrüder Weiss. Preflight
therefore never asks Gebrüder Weiss about a number.

## Links

The page's address puts the second field and the number in its path:
`/{language}/trackntrace/-/search/{shipper or consignee}/{number}`. Only the number is read from
such a link. The catalog has no link for one shipment, since the page needs the postcode.

## Limitations

- No tracking without the postcode. The search lists road and air orders for 90 days and sea
  orders for 120.
- Warehouse orders' events are not read.
- The page's details service (`/api/ptnt/public/orders/details`) keeps older orders, but it needs
  Gebrüder Weiss's own order number and the recipient's town, so it is not used.
- Gebrüder Weiss has no public tracking app.

## Testing

```sh
GEBRUEDER_WEISS_TRACKING_NUMBER=... GEBRUEDER_WEISS_POSTCODE=... GEBRUEDER_WEISS_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/gebrueder-weiss
```
