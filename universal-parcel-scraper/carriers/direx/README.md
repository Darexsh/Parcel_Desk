# Direx

Direx is a Bulgarian shipping company for online shops. It collects parcels at its warehouse
and hands them to a partner post or courier abroad, whose number the tracker also gives.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://old.direx.bg/track/multiple?itemNumbers[]={number}`, as the script
   of `direx.bg/track/` sends it for each number in the page's address. It needs no cookie,
   token, key, account or browser. The JSON reply is a list of shipments, each with its
   destination, product, partner, the partner's number on the label and its statuses.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- An empty list is the unknown-number answer; the page shows its "couldn't find anything"
  notice for it. A shipment without statuses is inconclusive.
- The lookup also finds a shipment by its partner's number, so a shipment counts only when its
  own Direx number is the one asked; a reply for another shipment or for several is
  inconclusive.
- Redirects are not followed. A redirect, a 404 or a 410 is a moved lookup, a bot check's page
  in place of the reply is a challenge, and any other reply that is not a list of shipments is
  a changed schema.

## Notes

- Each status has a code and an English name whatever the page's language. The map reads the
  code, then the name in English or in Bulgarian, as the former tracking page's message table
  gives them; anything else goes to the shared wording rules.
- A status's clock is the time it was added to the shipment, a wall clock without a zone. The
  reply does not list statuses in time order, so they are sorted by clock, as the page does.
- Direx's own statuses come to the second; those it copies from the partner come to the minute,
  so the partner's delivery can be dated before a transit row. A delivery or a return stands
  against transit rows dated after it, and a registration listed after the parcel moved is no
  step back.
- The partner is named only when the catalog knows its exact name and its link, if any, is its
  own; otherwise only its number is kept. A link alone names nobody: Direx links USPS parcels to
  its consolidator's tracker. A USPS routing barcode loses the ZIP code it opens with. The
  partner's link with the number filled in is never read.
- The product, kept as the service, and the destination country are kept; internal identifiers
  are not.

## Numbers

Direx gives each parcel a ten-digit item number without a check digit. Ten digits are shared
with DHL Express waybills and many other carriers' numeric references, so no rule claims them
and the carrier has no recognition. The tracking page lists some item numbers in an HTML comment,
and Direx's tracker answers them.

[Post One](../post-one/README.md), another Bulgarian operator with its own tracker, prints item
numbers of R and ten digits. Two of them stay in quarantine here; the adapter does not ask for
them.

## Links

The tracking page opens one or more parcels from its `code` parameter, which its own script
builds from the typed numbers.

## Limitations

- No place, delivery estimate, delivery time, weight, offsets or proof of delivery.
- Statuses copied from the partner are wall clocks like Direx's own; the reply does not say
  which clock they keep.

## Testing

`npm run test:carriers:live -- carriers/direx`, with `DIREX_TRACKING_NUMBER` and optionally
`DIREX_UNKNOWN_NUMBER` set outside the repository.
