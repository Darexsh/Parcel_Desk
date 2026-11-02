# Valmo

Valmo is the logistics network of the Indian marketplace Meesho. It collects from Meesho
sellers and delivers to buyers across India. Tracked through the lookup its track page makes.

## How it works

1. `direct`: one `GET https://www.valmo.in/api/valmo-web/track-order` with `request_id`, the
   time of the request in milliseconds, and `tracking_id`, as the track page sends them. It
   needs no cookie, token, key or browser. The JSON reply has the parcel's steps in order, each
   with the hub scans under it, a progress rail and a summary status.
2. `retry`: the same request once more when the first fails to reach the site or hangs. The
   first try gets half of the budget, so the retry fits in the rest.

- A tracking ID the tracker has no parcel for, never issued or expired, is HTTP 200 with
  `success: false` and the remark "Invalid AWB/Tracking ID", which the page shows under its
  form. That is read as not found; any other remark is inconclusive.
- The service refuses a lookup without `request_id` with HTTP 400. A 404 or a redirect is a
  moved route.
- The reply echoes the tracking ID as it was sent and must name the whole ID asked. The tracker
  reads a lower-case ID as unknown, so the adapter sends it in capitals.

## Notes

- Scan times are epoch milliseconds, so every scan is an instant, shown in India's offset to
  the second.
- Each step and hub scan has a status code (`ORDER_REACHED_HUB`) and the page's wording
  ("Reached Patna hub"). The code stages the scan; a hub scan's hub becomes its location.
  Steps the parcel has not reached yet, which the page greys out, are not scans.
- `ORDER_DELIVERY_FAILED` is an exception rather than a missed attempt: the page marks it as a
  failure, like a cancellation or a loss, and the parcel then goes back to the seller. A single
  missed attempt has its own code. The summary status can lag behind the newest step, so the
  steps decide the current stage.
- No recognition: the `valmo-1` rule is high confidence and no other carrier's numbers share its
  layout, so a lookup would settle nothing.

## Limitations

- No estimate, weight, recipient or proof of delivery. The page shows none.

## Numbers

Valmo tracking IDs are VL and thirteen digits. They appear on Valmo's own track page, in its
tracking API and in buyers' complaints about Meesho orders. The `valmo-1` rule claims that
layout; no other carrier's numbers share it. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

Valmo's track page opens one parcel at `www.valmo.in/track/` followed by the tracking ID; the
page reads the history from Valmo's tracking API.

## Testing

`npm run test:carriers:live -- carriers/valmo`, with `VALMO_TRACKING_NUMBER` and optionally
`VALMO_UNKNOWN_NUMBER` set outside the repository.
