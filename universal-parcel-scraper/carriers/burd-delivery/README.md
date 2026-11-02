# Burd Delivery

Burd Delivery is a Danish courier that brings webshop parcels to the door in the evening, by
bicycle and van. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one
   `GET https://burdorderstatusapiprod.azurewebsites.net/api/TrackAndTraceStatuses?number={number}`,
   as the script of `burd.dk/track` sends it. It needs no cookie, token, key or browser. The
   JSON reply is the parcel's list of statuses, each with its status type, its UTC time and
   the parcel's barcode.

- An unknown number is HTTP 400 with no body, which the page reports as not found. A 400 with
  a body is a changed reply, and a 404 or a redirect is a moved route.
- The service answers HTTP 429, without `Retry-After`, once an address has made a handful of
  lookups in a few minutes. The adapter makes one request and reports the 429 as rate limited.
- Every status must name the number asked.
- Recognition makes the same request.

## Notes

- Each status's `created` is a UTC instant, which the page shows in the visitor's zone. The
  adapter gives it at Denmark's offset, to the second.
- The page swaps the status type for the text the descriptions API holds for the webshop. That
  text is the same as the page's own built-in texts for each type, which the adapter uses
  without a second request. A type it does not know stays as written, as on the page.
- Each status also names the webshop's order number and Burd's name for the webshop. Neither
  is kept: the order number and the parcel's code together open the parcel's own page in
  Burd's notification emails.
- The page's link `burd.dk/track?code={number}` opens one parcel. The links in Burd's emails on
  `track.burd.dk` are not read.

## Limitations

- No location, delivery estimate, weight or proof of delivery.
- Parcels from abroad show nothing until Burd has them.

## Numbers

Burd's tracking page asks for the shipment number, eighteen digits by its own script. The
numbers in archived lookups are SSCCs, which any carrier labelling with GS1 codes can print, so
no rule claims them. The adapter takes eighteen digits with a valid GS1 check digit, and drops
the `00` identifier a label prints before them. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/burd-delivery`, with `BURD_DELIVERY_TRACKING_NUMBER` and
optionally `BURD_DELIVERY_UNKNOWN_NUMBER` set outside the repository.
