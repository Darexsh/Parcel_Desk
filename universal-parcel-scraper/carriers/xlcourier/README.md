# XLCourier

XLCourier (XL Courier, XLC) delivers extra-large and heavy parcels, such as furniture,
appliances and e-bikes, across the UK for businesses and online sellers, through its depots and
a national hub. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://de.xlcourier.com/custom-api/api/v3/xlc/getLogisticsTrack/{number}`,
   as the tracking page sends it. It needs no cookie, token, key or browser. The JSON reply has
   the parcel's scans, oldest first, and the recipient's address.
2. `retry`: the same request once more when the first does not reach XLCourier.

- A shipment is `code` "0". The page reports any other code as not found. The backend answers
  every number it holds no shipment for with HTTP 200, `code` "-1" and the message "parse
  tracking response failed", which is `NotFoundError`; another message is inconclusive. A 404 or
  a redirect is a moved route.
- The reply does not echo the number: the scans are those of the whole number in the request.
  The tracker ignores case. The adapter asks only for numbers that pass the page's own check.
- Recognition makes the same request.

## Notes

- XLCourier's API documentation describes a merchant endpoint, `logisticsTrack?waybillNo=`, with
  instants and the delivery photos. It does not find parcels the tracking page knows, so it is
  not used.
- Each scan's `tracking_event_status_id` is an event type from XLCourier's published status list
  and stages it; the shared wording rules read a type the list does not name.
- `updated_at_localized` is a wall clock to the second, and neither the reply nor the page names
  its zone, so the clocks stay `local_time`.
- A scan's wording is the line the page shows under its title, else the title, then the reason
  the page adds to a scan that did not go to plan. The reason loses phone numbers and e-mail
  addresses.
- A receiving scan names the depot or the hub the parcel arrived at, which becomes its location.
- The recipient's address, which the page pins on a map, is not kept.

## Limitations

- No delivery estimate, weight, service or delivery time as an instant.

## Numbers

XLCourier's tracking page checks a number against `XLC` and ten to twelve digits, or `ZX` and
eight digits, and the adapter takes the same. Its API documentation uses `XLC` and eleven digits
in its tracking example, and an aggregator offers `XLC` and twelve digits. `xlcourier-1` claims
the `XLC` layout. No public `ZX` number was found, so no rule claims that layout. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

`www.xlcourier.com/trackOrder?number={number}` opens one parcel: the tracking page reads
`number` from its address and looks the number up on load.

## Testing

`npm run test:carriers:live -- carriers/xlcourier`, with `XLCOURIER_TRACKING_NUMBER` and
optionally `XLCOURIER_UNKNOWN_NUMBER` set outside the repository.
