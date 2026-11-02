# Exmate

Exmate (이엑스메이트) flies e-commerce parcels from Korea to Japan, where a local carrier such as
Sagawa or Japan Post delivers them. Tracked through the page its tracking form opens.

## How it works

1. `direct`: one `GET https://pod.exmate.net/pod/?exmno={number}` with the cookie
   `UseLang=EN`, the language the page's own selector sets. It needs no token, key or browser.
   Without the cookie the server first sends a known number through its language switch. The
   HTML page lists the scans oldest first.
2. `retry`: the same read once more when Exmate cannot be reached.

- A number the tracker has no record of gets HTTP 200 with the bare text `No Data!!`, which is
  not found. A 404 or a redirect is a moved route.
- The page names the number in a hidden field and over the history; both must be the number
  asked.
- There is no recognition: `exmate-1` already names Exmate at high confidence.

## Notes

- Each scan has a clock to the minute, the country it happened in, Exmate's own status in
  Korean and an English line. The Korean status stays Korean on the English page; it is the
  provider code and stages the scan. The local carrier's scans carry its office and its own
  Japanese wording instead of the English line, or nothing.
- The page names no zone. Clocks of scans in Korea and Japan read in their shared offset,
  +09:00: departures and arrivals fit the flight, and deliveries fall in the day. A scan in
  another country would keep its wall clock.
- The page names the local carrier and its number once the parcel is booked with it, linking
  that carrier's tracker. A Sagawa or Japan Post link for the number shown is a hand-off. The
  page can switch carrier and number later, so only the current one counts.
- The tracker keeps reading the local carrier's number after the delivery, and that carrier
  reissues its numbers. A later parcel's scans then follow the delivery, so scans after the
  first delivery are dropped and a delivered parcel gets no hand-off.
- The port of loading and the progress rail are not kept.

## Limitations

- No estimate, weight or service.
- Numbers starting `EXJ`, which the tracking form opens on another page, are not read: no
  public one shows that page.

## Numbers

Exmate numbers are `EXK`, eight digits and `J`. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/exmate`, with `EXMATE_TRACKING_NUMBER` and optionally
`EXMATE_UNKNOWN_NUMBER` set outside the repository.
