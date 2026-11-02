# PPL

PPL CZ's public parcel history, for its eleven-digit parcel numbers, including parcels sent to
a ParcelShop or ParcelBox. DHL's other networks have their own carrier ids.

## How it works

1. `direct`: a POST with an empty JSON body to
   `https://api.dhl.com/ecs/ppl/webapi/TrackAndTrace/{number}`, the search PPL's tracking
   page runs, returns the parcel. It needs the page's key in a `dhl-api-key` header; no
   account, cookie or browser. The page loads reCAPTCHA but sends no token with the search,
   and the service asks for none.

## Access

The key comes from the widget configuration of PPL's tracking form, the
same for every visitor. DHL's gateway allows it only for PPL's tracking service. Node's fetch
cannot read that page: its `Content-Security-Policy` header is folded over several lines,
which the strict HTTP parser rejects. So the key is not read at run time; it is included with
the maintainer's approval. A rejected key is a challenge.

## Notes

- The reply must name the whole requested number. Only the service's shipment-not-found
  problem, for that number, makes a parcel unknown; any other rejection is inconclusive, and a
  web page instead of JSON is a challenge.
- The search asks for English wording. Every scan carries an event code, and the code alone
  decides the stage: several codes share one wording. Cash-on-delivery payment steps move
  nothing and are intentional gaps in the `statusMap`; unknown codes keep the stage before them.
- From a return scan on, the parcel travels back to its sender, so a later delivery leaves it
  returned.
- The pickup point is named only while the parcel waits there, or once it was collected there.
  Its name only: the reply's address, hours and position are not kept.
- The expected day is kept only while the page itself shows it and the parcel is still on its
  way, and is dropped when it falls before the latest scan.
- Scan clocks carry their UTC offset. A clock without one stays unresolved text.
- Numbers one apart both occur, so the last digit is no check digit. The first digit names the
  product, from 2 for export parcels to 9 for company pallets in PPL's API documentation, so
  `ppl-1` takes eleven digits starting 2 to 9. Eleven digits are shared with other carriers,
  so it only suggests PPL among them.
- Recognition makes the same search. A Czech caller, or a provider that names PPL, asks PPL
  first; otherwise the commoner eleven-digit carriers are asked before it. Providers name PPL
  beside the DHL networks that take a parcel abroad, and only PPL's rule fits its number.
- A parcel handed to a partner abroad carries the partner's number and a link to the
  partner's tracker, such as Poste Italiane's with a DHL Parcel Connect `JJD` plate. When the
  link carries that number and names one catalog carrier, the result names both, so the host
  can follow the parcel there.

## Limitations

Scans carry no place, so events have no location. A partner abroad whose link names no catalog
carrier is not named. SmartPIN and other search forms are not supported. The
sender, customer reference, delivery window, payment details and proof of delivery are not
read.

## Links

PPL's home page opens its search form on one parcel at
`www.ppl.cz/?form=track-and-trace&shipmentId={number}`: the page reads the number from the address
and runs the search itself. The former `/vyhledat-zasilku`, which redirects there, and the English
`/en/track-a-shipment` and `/en/parcel-detail` take the same parameter.

## Testing

```sh
PPL_TRACKING_NUMBER=... PPL_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/ppl
```
