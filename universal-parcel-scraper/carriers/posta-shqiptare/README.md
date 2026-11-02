# Posta Shqiptare

Tracks Posta Shqiptare items, letters, parcels and EMS, through the lookup the e-Posta tracking
page makes.

## How it works

1. `direct`: one `GET https://eposta.postashqiptare.al:8443/api/mailItemEvents/getTrackApi/{number}`,
   as the [e-Posta tracking page](https://eposta.postashqiptare.al/tracking) makes it for the code
   in its address. No account, key, cookie, CAPTCHA or browser is needed. The JSON reply lists the
   item's scans, newest first.
2. `retry`: one more try when the request fails to reach the tracker or hangs. The first try gets
   half of the budget.

- The reply does not repeat the number; the lookup's address holds the whole of it.
- A code without scans gets an empty list, which the page reports as having no events for the
  barcode. The adapter reads it as not found, as it does the page's own notices for a missing
  item. A 404 or a redirect is a moved route, and a bot check in place of the JSON is a challenge.
- Recognition makes the same request.
- The tracking form on the main site posts the code to that site's search service, which gives
  the same scans behind Cloudflare, only for the site's own origin. The adapter does not use it.

## Numbers

The tracker takes UPU S10 item codes, two letters, nine digits and two letters. The adapter takes
them with a valid check digit, from any country; anything else is invalid without a request.
Posta Shqiptare's own codes end in `AL`. Detection names it for the parcels, EMS, registered and
tracked-letter items it issues: `C`, `E`, `L` or `R` first, `AL` last and a passing check digit.
Its tracker follows them abroad, relaying the foreign post's or courier's scans. Its other `AL`
codes stay with the generic postal carrier, as the issuer of an S10 code does not establish who
delivers it, and the low-confidence `posta-shqiptare-s10` rule makes preflight ask Posta Shqiptare
about them.

## Notes

- Each scan has a clock without an offset, its wording, an office and a destination, which is
  always empty and is not read. Posta Shqiptare's own scans are worded in Albanian with the UPU's
  IPS event name in English after a slash, and name the office and its town. The scans it relays
  from the foreign post have the Albanian wording alone and name that post's country in Albanian,
  which becomes its English name. An EMS item a courier carries abroad gets the courier's scans,
  in Albanian, each with a town and a three-letter country code.
- Posta Shqiptare's own scans are on Tirana's clock: UPU's tracker has the posting at the same
  minute. A relayed scan's clock is hours ahead of the foreign post's own, by an amount that
  differs between countries, and nothing shows the zone of a courier's clock, so those scans keep
  their wall clock without an offset, as does an hour the clocks skip or repeat in Albania.
- The map reads the Albanian wording without accents; wording it does not know goes to the shared
  wording rules. The courier's "Marrë nga korrieri" (taken by the courier) comes before its
  delivery but does not say the item went out for delivery, so it stays in transit.
- A delivery's wording keeps only its own words, since more could name who took the item, and a
  place with a postcode is dropped.

## Limitations

The tracker has no delivery estimate, weight, service, pickup point or proof of delivery, and the
relayed scans carry no number of the partner's own, so no delivery partner is named. Items other
posts send to Albania have not been seen; their scans are staged by their wording until the map
knows them.

## Links

One item opens on the e-Posta site at `/tracking/{number}`, which looks the code up and shows it in
its heading. The main site's form takes the code only as typed.

## Live test

Set `POSTA_SHQIPTARE_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/posta-shqiptare`. Optionally set
`POSTA_SHQIPTARE_UNKNOWN_NUMBER` to check a code without scans.
