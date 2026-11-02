# AyMakan

AyMakan is a courier in Saudi Arabia. It collects parcels from online shops' collection points,
sorts them at its hubs and delivers them from city warehouses, to the door or to its lockers.
Tracked through its tracking page.

## How it works

1. `direct`: one `GET https://aymakan.com/tracking/{number}`, the page the tracking form opens.
   The site renders it on its server, so the HTML holds the shipment's status over
   "Tracking #:" and the number, and its timeline, newest first. It needs no cookie, token, key
   or browser.
2. `retry`: one more request after a network failure or a timeout.

- An unknown number is HTTP 200 with "No shipment found" under the search form, which keeps the
  number searched. Only that answer, for the number asked, is not found.
- The page must show "Tracking #:" with the number asked.
- Cloudflare is in front of the site. Its challenge or block page, with HTTP 200 or 403, is a
  challenge. A redirect or a 404 is a moved page.
- Recognition makes the same request.

## Notes

- The timeline dates each scan by weekday, month and day, without a year or a clock, so each scan
  keeps only its day in `local_time`. The year is the latest one, up to the day after the lookup
  in Saudi Arabia, in which that day falls on that weekday. A day comes round on the same weekday
  after five years at the soonest, so scans under five years old are dated exactly.
- The status over the shipment is the carrier's current one and decides the stage. The newest
  scan with a stage decides only a status the map does not know. The tracker has no codes;
  [`status.ts`](status.ts) stages both the statuses and the timeline's wordings from AyMakan's
  list of statuses.
- A delivery's wording loses the clause naming who took the parcel, and every wording loses
  phone numbers. The progress rail, the route and the masked sender and recipient are not kept.
- AyMakan's app tracks a shipment for a guest only after the recipient's mobile number and a code
  sent to it, so the adapter does not use it.

## Limitations

- No scan times or locations, beyond a city some wordings name.
- A scan five years old or more can be dated to a later year.

## Numbers

AyMakan tracking numbers are `AY` followed by digits. Its tracker, its API documentation and
its PHP SDK show nine, ten and eleven digits after the prefix, and `aymakan-1` claims them.
Older shipments carry a bare six-digit number, which archived lookups on the tracker, the API
documentation and the SDK show. The adapter tracks both shapes. No rule claims six digits: many
carriers print short digit runs.

## Links

AyMakan's tracking form sends one number, or several separated by commas, to
`aymakan.com/tracking/{number}`, which opens the shipment. Archived lookups use the former
`aymakan.com.sa/en/tracking/{number}` and `aymakan.com.sa/ar/tracking/{number}` addresses.

## Testing

`npm run test:carriers:live -- carriers/aymakan`, with `AYMAKAN_TRACKING_NUMBER` and optionally
`AYMAKAN_UNKNOWN_NUMBER` set outside the repository.
