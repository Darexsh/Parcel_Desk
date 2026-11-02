# Barid Al-Maghrib

Tracks Barid Al-Maghrib items, Amana parcels included, and the S10 items other posts send to
Morocco, through the tracking page on barid.ma and the lookup its search form makes.

## How it works

1. `direct`: one `GET https://www.barid.ma/bamb2cstorefront/fr/tracking/getdetailentrytracking?code={number}`,
   the page the search form opens for one code. The site renders it on its server. It needs no
   account, cookie, token, key or browser.
2. `retry`: a lookup that fails to reach the site, or hangs, is sent once more within the budget.
   The first try gets half of the budget.

- The page names the item, which must be the whole requested code, and lists its history.
- The page sends a code it has no history for back to the empty search form. The adapter then
  makes the form's own lookup, `GET .../fr/tracking/getTrackingByCode?trackingCode={number}`,
  whose JSON lists a code it does not know under `errors`, which is not found. A code it lists
  under `tracking` is known but has no history to read, which is inconclusive.
- A 403 or a firewall page, even with HTTP 200, is a challenge, a 429 a rate limit and a 503
  maintenance. A 404, a 410 or a redirect elsewhere is a moved route. Recognition makes the same
  requests.

## Notes

- The history has a row per day, then that day's scans newest first, each with a clock, an office
  and a French wording. The clock is on a twelve-hour dial without AM or PM, so an afternoon
  delivery reads earlier than the same morning's scans. Each scan keeps its day as
  `local_time` and the printed day and clock as `provider_time_text`; no hour or zone is
  inferred. Recognition therefore gives no last-activity instant.
- Mail from abroad carries the sending post's scans, with that post's offices and days.
- The adapter keeps the weight and maps the arrival position to a country code. It drops the
  item's kind, the cash-on-delivery amount, the departure position, the delivery phone and the
  progress rail. The lookup's entries carry the recipient's name and address, which it never
  reads.
- Only the French page exists; the `en` and `ar` routes answer 404.
- The My Amana app reads `trackingHeader` and `trackingDetail` from a host its Firebase Remote
  Config names, with a Keycloak client-credentials token from the `EcomAmana` realm on
  `oauthbam.barid.ma` and a tracking key. Both hosts time out for outside clients, so the adapter
  reads the website.

## Limitations

- The page gives no clock of day, ETA, service or recipient.
- Older items drop out of the tracker and then read as not found.
- The adapter takes only S10 codes with a valid check digit. The form takes several codes split
  by `;`; the adapter sends one.

## Numbers

Barid Al-Maghrib prints UPU S10 numbers ending in `MA`. Customers quote items starting `RR` and
`LD`, and Amana parcels starting `CP`. Mail from abroad keeps the suffix of the post that issued
it, and the tracker answers for it too. The adapter takes S10 codes from any post with a valid
check digit; anything else is invalid without a request.

The issuer of an S10 code does not establish who delivers it, so detection keeps codes ending
`MA` with the generic postal carrier, Amana's `CP` codes included. `barid-al-maghrib-s10`, at low
confidence, makes preflight ask Barid Al-Maghrib about them. Mail from abroad reaches Barid
Al-Maghrib when a caller names it, a provider names it, or a result gives Morocco as the
destination of an S10 item. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page on barid.ma sends a single number to
`/bamb2cstorefront/fr/tracking/getdetailentrytracking?code={number}`, which opens one parcel.
The former tracker at bam-tracking.barid.ma took the number as `trackingCode` on
`/Tracking/index`; that host no longer answers.

## Testing

`npm run test:carriers:live -- carriers/barid-al-maghrib`, with
`BARID_AL_MAGHRIB_TRACKING_NUMBER` set outside the repository to an item the tracker knows.
Optionally set `BARID_AL_MAGHRIB_INBOUND_NUMBER` to check mail from abroad and
`BARID_AL_MAGHRIB_UNKNOWN_NUMBER` to check a code the tracker does not know.
