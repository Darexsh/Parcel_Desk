# iMile

iMile delivers cross-border e-commerce parcels, mostly flown in from China, in the Middle East,
Latin America, Europe, South Africa and Australia. Tracked through the lookup its tracking page
makes, with the China leg Cainiao's global tracker holds under the same number.

## How it works

1. `direct`: one `GET https://www.imile.com/saastms/mobileWeb/track/query?waybillNo={number}&code={code}`
   with the headers `lang: en_US` and `sign`, as the tracking page sends it. `sign` is the
   number encrypted with the RSA public key in the page's script (PKCS#1 v1.5, base64), and
   `code` is the MD5 of the number followed by a salt from the same script. Both values are the
   same for every visitor and ship with the adapter. No cookie, account or browser. The JSON
   reply has the shipment and its scans, newest first, in English.
2. `retry`: the same read once more when the first did not reach the site.
3. `cainiao`: once iMile has answered with scans, Cainiao's
   `GET https://global.cainiao.com/global/detail.json?mailNos={number}&lang=en-US`, read as the
   AliExpress adapter reads it. For a parcel Cainiao carries out of China, it has the pickup,
   sorting, export and flight scans from before iMile's. It gets half of the time iMile left,
   at most eight seconds. A slider, a rate limit, a changed reply or a number Cainiao does not
   know is recorded with its kind and leaves iMile's answer as it is.

- An unknown number is HTTP 200 with `"resultObject": null`, which the page reports as no data.
  A missing or wrong `sign` gets the same reply, so after an empty reply the adapter reads the
  tracking page and its script, at most once an hour, and asks again if the key or salt
  changed. A page that no longer names its script, or a script without the values, is a
  changed page.
- A `status` other than `success` is inconclusive, or rate limited when its message says so. A
  404 or a redirect is a moved route. Cloudflare, in front of the site, lets the package's
  default User-Agent through.
- The shipment must echo the number asked.
- Recognition makes the same read without Cainiao: a shipment with scans is known, the empty
  reply is not.

## Cainiao's leg

- Cainiao's record must name iMile as the destination carrier or a scan's carrier; another
  network's parcel under the same number adds nothing. Cainiao never makes a number iMile's: a
  number iMile does not know, or knows without scans, stays iMile's answer.
- Cainiao relays iMile's own scans on its own clocks, sometimes reworded. iMile's first scan
  past its order record, such as a pickup, a centre or a flight, marks where iMile has the
  parcel. Cainiao's scans count up to the newest one older than that scan, comparing instants;
  a clock without a zone is taken at the earliest it can be. A scan at the same instant as one
  of iMile's, such as Cainiao's record of iMile's order, stays out. The rest go among iMile's
  older scans, newest first.
- iMile's scans, stage, status and summary stay as iMile gave them, since iMile delivers the
  parcel. While iMile has only its order record, the parcel is still on Cainiao's leg, and the
  newest scan of either gives the status.
- Cainiao's scans keep its action codes, placed in its own zones. The `imile` status map reads
  them with Cainiao's; iMile's own codes are numbers.

## Notes

- Each scan's `time` is a wall clock to the second with no zone. The page says it shows the
  recipient country's time. In a Saudi history the take-off and landing scans read five hours
  behind the clocks of the flight's own schedule line, which are China's, so the scans are
  Saudi time, and a Colombian take-off reads just after its flight's departure on Colombia's
  clock. A recipient country with one zone places every scan as an instant, and so does New
  Zealand, whose other zone is the Chatham Islands': its delivery stations keep Auckland's clock,
  as Australia's keep their own. Australia, Brazil, Mexico and the United States span several
  zones and the reply does not say which, so their clocks stay `local_time`.
- A scan's description is its own sentence without the brackets the page shows. A name in 【】
  opening a scan is its centre, which the location shows, or else heads the sentence ("BOG:
  Clearance start."); the other names, and the reasons and dates in <>, keep their words.
  The `trackStage` code stages it: Delivered (`2060`) and Returned to Client (`2065`) decide
  whatever the sentence says. Return Handling Process (`1008`) is the way back, centres and
  drivers' reasons included, so it reads as a problem until a sentence says the sender has the
  parcel. In Transit (`1002`) and
  Delivery (`1003`) cover flights, clearance, centres, delivery runs and drivers' reasons, which
  the sentence tells apart. A booked delivery day and a stock count move nothing, and so does the
  recipient choosing to collect the parcel; a sentence asking them to collect it at a named point
  with their pickup code means it waits there, not that it was delivered. A flight
  booked for the parcel, with its planned clocks, is still to come: a row that only books one is
  left out, and a scan it follows keeps its own words. Some scans come without a code. "Traffic, Strike, Bad weather" is a failed attempt on a
  delivery run and a delay under In Transit, before the parcel reaches its delivery office.
- Delivery runs lose the driver's phone, deliveries lose who took the parcel, and Brazilian
  deliveries and returns lose iMile's support contacts. The proof-of-delivery photos some
  countries link are not kept.
- `country` is iMile's own three-letter code, mostly ISO's, though `KSA`, `UAE`, `RSA` and `BIH`
  (Bahrain) are its own. It becomes `destination_country`.
- The page shows `lmWaybillNo` as the last-mile number of US parcels. The reply names no courier
  for it, so there is no hand-off.
- The page asks `/saastms/mobileWeb/getLatestDeliveryDate` for an estimated delivery date. The
  answers seen were empty, so the adapter does not ask.

## Limitations

- No estimated delivery, weight or service, and no delivery time as an instant.
- Cainiao has no record of the parcels it did not carry, such as other marketplaces'
  thirteen-digit waybills, and still gets asked. Its departure scan can sit beside iMile's
  take-off scan for the same flight. In a country with several zones, the Cainiao scans in the
  fourteen hours before iMile's first stay out, and its record of iMile's order stays in.
- The tracker also answers marketplace references with CNBR and AP prefixes, which belong to
  the sender's logistics partner. The adapter tracks one filed under iMile, but no rule claims
  them.

## Numbers

iMile's own waybill numbers are thirteen digits. Most are a 6, the day the waybill was made as
month, day and two-digit year, then six digits: every sample was reported days or months
after its date. `imile-2` suggests iMile for that layout, with years from 24, at low confidence.
Other carriers' thirteen digits are a bare counter that can fit it, Korea Post's domestic
parcels among them, so the tracker has to confirm the number. Every parcel seen in the layout
was iMile's, so detection lists iMile first, ahead of the country hint, and keeps the others as
candidates. The waybills that start with 3 show no such date, and no rule claims them. Its
Italian parcels also carry `IM` and fourteen
digits, which iMile calls their waybill number. Every sample starts `IM0601`, so `imile-3`
names iMile for that prefix. No other carrier's rule takes the layout, and `imile-1` suggests
iMile with low confidence for other prefixes. Other Italian parcels carry 49 and twelve digits:
iMile's own tracker answered two of them with their history, though no public page shows a whole
number in that layout. Fourteen digits are shared with DPD, BRT and others, and Turkish
carriers' numbers can start with 49 too, so `imile-4` only suggests iMile. Every parcel the app
tracked in that layout was iMile's, so detection lists iMile first, ahead of the country hint,
and keeps the others as candidates. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker on `imile.com` opens one parcel at `/<country>-<language>/track` with the number in
`?waybillNo=`. The form on the English page builds that address.

## Testing

`npm run test:carriers:live -- carriers/imile`, with `IMILE_TRACKING_NUMBER` and optionally
`IMILE_UNKNOWN_NUMBER` set outside the repository. `IMILE_CAINIAO_TRACKING_NUMBER`, a parcel
both iMile and Cainiao have scanned, checks Cainiao's leg.
