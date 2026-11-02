# Urvaam

Urvaam is a last-mile delivery company in Madrid that delivers parcels sent from China, among
them YunExpress shipments. Parcels go through its Madrid or Barcelona platform to a local depot
or partner that delivers them. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://ur-api-cli.ifbird.com/track/batch` with the form body
   `line_nos={number}`, as the tracking page sends it. It needs no cookie, token, key or
   browser. The JSON reply lists the shipments found, each with its scans newest first.
2. `retry`: a read that does not reach the service, or hangs, is tried once more in the rest
   of the budget.

- An unknown number is HTTP 200 with an empty `data` list, which the page reports as having no
  tracking yet. A 404 or a redirect is a moved route, and `meta.code` 1000 is the service
  asking for a signed-in session.
- Only the shipment whose `line_no` is the whole number asked counts.
- Recognition makes the same request.

## Notes

- Each scan's `update_time` is a wall clock to the second with no zone. The page names no
  zone, so the clocks stay `local_time`.
- A scan's wording is its Spanish caption. A receipt at a platform or depot names it in
  brackets, as in `Recibido Plataforma (Urvaam-Mad)`; the wording loses the brackets and the
  depot becomes the scan's location.
- The scan's `status` code stages it. The receipt at Urvaam's platform is the acceptance. A
  failed delivery (`Incidencia`, with its reason) is a failed attempt unless the reason is a
  loss, a theft, missing contents, damage or a refusal. A return reads from the wording:
  `Devolver al remitente` starts it under the platform's code and `Devuelto al remitente` ends
  it under the delivery code. A code the map does not know takes the tracker's own category,
  `track_status`, except that the category files failed deliveries under in transit, so the
  wording rules come first there.
- The page can show a pickup point under a scan, with its opening hours. Its name, street and
  town are kept as the pickup point and the town as the scan's location; the hours are not.
- The customer number beside the shipment is the sender's reference, which belongs to the
  sender's carrier, and is not kept. The signature link, the driver and the captions in other
  languages are not kept either.
- The adapter sends only Urvaam's own numbers. The tracker also searches the sender's
  reference, such as a YunExpress number, but that number belongs to the sender's carrier and
  the search is not an exact lookup, so the adapter refuses it as input.

## Limitations

- No estimate, weight, service, or delivery time as an instant.
- No detection rule offers Urvaam's numbers, so preflight does not ask its recognition, and
  YunExpress, which names a last-mile carrier only when detection offers its number, does not
  hand a parcel off to Urvaam.

## Numbers

Urvaam tracking numbers are sixteen digits starting `27` or `28`, seen in public consumer
complaints and an archived lookup on Urvaam's tracker. The numbers rise over time, so the
adapter accepts any sixteen digits starting with `2`. Sixteen digits are shared with several
carriers, so no rule claims them. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`www.urvaam.es/track/result?no=` followed by the number opens one parcel; the search page
builds that address.

## Testing

`npm run test:carriers:live -- carriers/urvaam`, with `URVAAM_TRACKING_NUMBER` and optionally
`URVAAM_UNKNOWN_NUMBER` set outside the repository.
