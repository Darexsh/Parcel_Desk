# Thailand Post

Tracks Thailand Post's S10 numbers ending in `TH`, domestic and outbound international,
through the JSON service behind the official tracking site, `track.thailandpost.co.th`.
No key, session or browser is needed.

## How it works

1. `direct`: `POST https://trackweb.thailandpost.co.th/post/api/web/getMailing` with the
   site's own payload for one number. The site encodes the body as base64 of a JSON
   envelope cut into nine parts, followed by a base64 index of each part's position and
   length. The encoding has no key, and the service accepts the parts in order.
2. `mirror`: the same request to `trackweb2.thailandpost.co.th`, the site's other host,
   after a network failure or HTTP 405, 408, 429 or 5xx without `Retry-After`, while a
   second of the budget is left. A requested pause ends the lookup on either host.

## Notes

- The reply is a map keyed by the numbers asked for. It must hold exactly the requested
  key, and every scan must name that number in `mailingNo`, its prefix and its suffix.
- `null` under the key is the site's answer for an unknown number. A reply keyed by another
  number is a different shipment, and one without the key a refused request, never
  not-found. HTML, and a refusal that mentions verification, a captcha or API
  registration, are challenges; one that says too many requests is a rate limit.
- A rate limit stays one even when its page says access is denied. On other error
  statuses only an interactive check's page is a challenge.
- The payload's `checkBot` must be `"1"`; without it the service answers with an empty key.
- `createDate` is epoch milliseconds. Thai scans are instants and keep `+07:00`. Scans a
  foreign post relays by EDI (portal `99999`, outlet type 25, item flag `EDI`, office
  `International (<country>)`) hold that post's wall clock stored as if it were Bangkok
  time: Japan Post's own record of an inbound item matched them on the clock, not the
  instant. They stay in `local_time` without an offset, and a history that mixes both keeps
  the service's order, newest first.
- Stages come from the scan code, which follows the UPU EMSEVT events in the site's status
  table. A final delivery reads its delivery result: `S` is the addressee's delivery and `L`
  the sender receiving a returned item. The utility code takes its delivery result's
  meaning, so it is an unsuccessful delivery only in the unsuccessful status group. Other
  codes go to the shared wording rules, then to the status group for the last mile and
  for unsuccessful deliveries. The delivered group also holds the COD payment to the
  seller, so it settles nothing.
- The contact-recipient scan is the delivery officer's call, and the COD payment to the
  seller follows the delivery. Both keep the stage before them. The call's detail masks
  the recipient's phone number, so only its label is read, and the payment's office is
  not a location.
- `delivered_at` is the newest final delivery to the addressee, never a later call or
  payment.
- `statusMap` in [status.ts](status.ts) answers the app's review queue by scan code. It
  leaves the call and the COD payment without a stage on purpose; a final delivery, a
  utility row and other codes depend on the rest of the scan, so it does not answer them.
- Recipient name and relation, signature and photo, delivery officer, office phone, GPS
  point and staff identifiers are never read. The signature and location endpoints are not
  called.

## Mobile app and other routes

The Android app `com.abs.trackandtrace` posts to `/post/api/android/...` routes on the same
host. Its tracking call needs a `token_web` the server pushes to the device after
`api/mobile/requestTokenWeb`, a per-device session; without one the reply is empty, and a
made-up one is refused with a request to register for the API. The public
`trackapi.thailandpost.co.th` API issues a token per registered user. Neither is used.

The site bundle includes a Cloudflare Turnstile component and sends `turnstileToken: null`;
no page renders it. Enforcement would surface as a challenge, not as not-found.

## Limitations

- History expires within months, and an expired number gets the same `null` as an unknown
  one.
- Items other posts issued (other suffixes) are served by the same endpoint for their Thai
  leg, but detection does not route them here.
- The foreign-clock rule comes from an inbound item's origin scans; a destination post's
  scans of an outbound item carry the same markers and are read the same way.
- No delivery estimate.

## Testing

`npm run test:carriers:live -- carriers/thailand-post` sends a well-formed unknown number.
Set `THAILAND_POST_TRACKING_NUMBER` to a real number to read one history.
