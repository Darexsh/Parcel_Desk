# Cargus

Tracks Cargus AWB numbers, Ship & Go shipments included, through the guest parcel trace of
the Cargus Android app, `com.cargus.cma`. No account, cookie, browser or device registration
is needed. The adapter includes the app's shared key.

## How it works

1. `direct`: one GET to the app's service on Azure,
   `https://cmacwabackend.azurewebsites.net/api/Awbs/ShortTrace?BarCode=<number>&lang=EN`.
   The reply names the AWB, a summary status and the scans, oldest first, each with its
   wording, an offset-less clock, a town and a county. An AWB the service does not know is an
   empty 204.

## Access

The app proves itself on every request: it encrypts a fresh random 12-character message
with AES-128-CBC under a key compiled into the app, the same for every install, and sends
the ciphertext in `k`, the IV in hex in `seed`, and `s: M`. The key is included with the
maintainer's approval. A missing or wrong key gets a bare HTTP 400, which is a challenge.

## Notes

- Retrieval: the website's tracker, `www.cargus.ro/personal/urmareste-coletul/`, answers
  plain HTTP without a CAPTCHA but shows one status line with a 12-hour clock and no AM or
  PM, and reports as not found most parcels the app service knows, recent ones included. The
  app's other parcel reads need a signed-in user.
- Identity: the reply's `awbBarcode` must be the requested number. Letters and leading
  zeros are sent as written; the service answers both with the empty 204 seen for unknown
  numbers.
- Times: every clock is a wall time without an offset, kept to the second in `local_time`;
  the catalog zone is `Europe/Bucharest`. No update instant or delivery estimate is
  invented. Scans of the same clock keep the service's order, reversed, so the later listed
  comes first; a scan repeated within one second is kept once.
- Location: the town, then its county unless it has the same name.
- Stages: scans carry no code, so `status.ts` maps the wording. The summary status keeps
  "New" after the first scan, so it stages only a parcel without scans, which is then
  summary-only. Wording the map does not know takes its stage from the shared wording
  rules.
- The reply also names who signed for the parcel with a delivery PIN, the sender's
  cash-on-delivery or return reference and the piece counts. None of them is read.
- A 404 or 410 is a moved route, not an unknown AWB; a web page in place of JSON is a
  challenge.

## Numbers

Cargus's tracker takes the AWB number. Lookups archived from it show ten digits starting with 1,
a series that rose from 10 in 2023 to 12 in 2026, and, from 2023 to 2025, hundreds of nine-digit
AWBs in one block starting with 85 or 86. Lookups through the former site's tracking script,
from 2014 to 2016, show three letters, eight digits and a letter. Nine and ten digits are shared
with several carriers and nothing in the number points to Cargus, so `cargus-1` and `cargus-2`
only suggest it for those two layouts, and recognition asks Cargus only when the lookup's
country is Romania. The letter layout has not been seen since 2016 and has no rule.

## Links

Cargus's tracking form sends the number as `tracking_number` to
`www.cargus.ro/personal/urmareste-coletul/`, or to `/en/personal/track-your-parcel/` in
English, so `www.cargus.ro/personal/urmareste-coletul/?tracking_number={number}` opens one
parcel. Lookups archived from the former tracker carry the number as `t` on
`/tracking-romanian/`, which now redirects to the current page.

## Limitations

- The service forgets older parcels: an expired AWB and an unknown one get the same empty
  204, so both are not found.
- A parcel handed to a third party for delivery keeps its last warehouse scan and "In
  warehouse" here, while the website shows the hand-off ("Expediere livrata de o a treia
  parte"). The website is not read, since its clock has no AM or PM.

## Testing

`npm run test:carriers:live -- carriers/cargus` reads `CARGUS_TRACKING_NUMBER` and
`CARGUS_UNKNOWN_NUMBER` from the environment.
