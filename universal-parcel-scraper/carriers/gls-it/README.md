# GLS Italy

GLS Italy's national shipments, tracked through the national search of GLS's Italian
tracking page.

## How it works

1. `direct`: one `GET https://gls-group.com/app/service/open/rest/IT/en/rstt030?match={number}&type=NAT&caller=witt002`,
   the request the Italian tracking page makes for a national shipment, in its English
   locale. The JSON reply carries the whole history. No cookie, token, postcode, account or
   browser is needed.
2. `retry`: one more try when the request fails to reach GLS or hangs. The first try gets
   half of the budget.

The GLS group tracker that GLS Switzerland and Germany use does not know Italian national
numbers, so this adapter does not share their route.

- The reply names its shipment with a space after the depot code; it must be the requested
  number, otherwise `SchemaError`. A reply of several rows is read as the page reads it: the
  shipment first, then its parcels.
- A number the tracker does not know returns HTTP 404 with its "no results" notice, in
  English or Italian: `NotFoundError`. Any other error reply or web page is inconclusive, and
  a bot check is a challenge.
- Recognition makes the same request; the not-found notice is the only unknown answer.

## Notes

- Scans carry a sentence and no code. The sentences are mapped whole in [status.ts](status.ts);
  others go to the shared wording rules. The English locale sometimes answers with the Italian
  sentences. Each is shown in the English locale's words for that scan, which take over a row
  stored in Italian at the same instant and place. A request that names a language with
  `Accept-Language` gets an internal error instead. When the newest sentence gives no stage, the
  current step of the page's progress rail stands in. GLS's return flag makes the shipment
  returned.
- The national search only answers for shipments inside GLS Italy's network, so a timed scan
  is read in Italian time. A scan with only a date keeps the date as a local clock, and so does
  an hour the clocks skip in spring.
- The weight is kept. The depots, the sender's and recipient's towns, the customer's
  reference, the departure date, the signer and the masked name beside a delivery are never
  read.

## Numbers

A national shipment number is the two-character code of the sending depot, a letter then a
letter or digit, followed by at most nine digits. The page prints it with a space after the
code, and the service fails on that space, so the adapter sends the number without it.
`gls-it-1` suggests GLS Italy at low confidence when the code is two letters and nine digits
follow, and `gls-it-digit-depot` when the code is a letter and a digit. That second shape, a
letter and ten digits, is also UPS's, DTDC's and Packeta's, so it stays one suggestion among
theirs and recognition asks GLS Italy. The eleven-digit cross-border numbers and the long
parcel IDs ending `GLS` stay unclaimed.

## Links

The Italian search page reads the number from `?match=` and the search type from `type`.
Without `type=NAT` the page sends its search with an empty type, which the service
rejects, so the catalog link carries it.

## Limitations

- Parcel numbers, delivery-note references and international searches are not supported.
- A shipment forwarded or returned under a new number is not followed.
- No delivery estimate, pickup point or sender name.
- Older shipments drop out of the tracker and come back not found.

## Testing

```sh
GLS_IT_TRACKING_NUMBER=... GLS_IT_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/gls-it
```
