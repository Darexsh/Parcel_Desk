# Equick

Equick (网易速达) is a Beijing cross-border shipping company. It collects merchants' parcels in
China and flies them to Europe and Canada, where a post or courier in the destination country
delivers them. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://api.equick.cn/api/traceQuery` with the body
   `{"txtDanHao":"{number}"}`, as the tracking page sends it. It needs no cookie, token, key or
   browser. The JSON reply keys each number asked, as it was sent, to its scans, newest first.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- A number the tracker does not know has no key, so it gets `{"code":1,"data":{}}`, which the
  page reports as no result. A `code` other than 1 is a lookup the service did not complete,
  and a 404, a 405 or a redirect is a moved route.
- Every scan names the shipment's number, which must be the whole number asked.
- Recognition makes the same request.

## Notes

- The page at `www.equick.cn` answers on plain HTTP only and calls the service at
  `api.equick.cn:8080` over HTTP. The same service answers on `api.equick.cn` over HTTPS, which
  the adapter uses.
- Each scan's `traceDateTime` is a wall clock to the second, with no zone. Equick relays the
  destination carrier's scans, whose clocks can be that country's, so every clock stays
  `local_time`.
- The newest scan with a stage decides the status. Each scan also has a Status column label,
  such as `In progress`, and a pick-up scan the parcel moved on from was labelled `Hold`, so
  the label is not kept and sets no stage.
- Scans carry the delivering carrier's number in `destinationWBNo` once Equick has handed the
  parcel over; it becomes the delivery tracking number. The reply does not name that carrier,
  so there is no delivery carrier.
- Scan wordings lose who signed for the parcel and phone numbers. The destination country is
  the scans' `traceCountry`.

## Limitations

- No delivery estimate, weight, service, sender or recipient, and no delivery time as an
  instant.

## Numbers

Equick numbers read `EQK`, two letters, ten digits and `YQ`. Equick's own tracker knows a
sample number of that layout, and no other carrier's numbers have it, so `equick-eqk` claims
them. Its older tracker showed nine-digit numbers, a shape other carriers share, so no rule
claims those; the adapter still takes them when Equick is chosen. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The tracker at `www.equick.cn/#/support/supportWay` reads `nums` from the address fragment and
looks the numbers up at once; its copy-link button builds that address. The site answers on
HTTP only, so there is no search page and no URL template.

## Testing

`npm run test:carriers:live -- carriers/equick`, with `EQUICK_TRACKING_NUMBER` and optionally
`EQUICK_UNKNOWN_NUMBER` set outside the repository.
