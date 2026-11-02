# Mainfreight

Mainfreight is a New Zealand freight and logistics group. Its transport networks in New Zealand,
Australia, the United States and Europe carry pallets and freight between businesses, and its
air and ocean arm forwards shipments worldwide. Tracked through the lookups its tracking page
and app make.

## How it works

1. `direct`: `GET https://www.mainfreight.com/track/api/trackings?reference={number}`, the
   search the tracking page makes. It lists each shipment matching the number with its address
   on the tracker, a service code and Mainfreight's own number such as `CW/{job}`. The adapter
   then opens that shipment with `GET …/trackings/{code}/{number}?lang=en-NZ`, as the page does
   when the search lists a single shipment. Neither needs a cookie, token, key or browser.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The search misses New Zealand, Australian and American transport consignments under their
  eleven-digit numbers; only their service's tracking link opens them. When the search lists
  nothing for eleven digits, the adapter opens the number under `MSNZS`, `MSAUS` and `MSUSS` at
  once. Two services answering is inconclusive.
- The search also matches other fields. The adapter keeps the entry whose own number is the
  whole requested number, else the one whose reference is. Several such entries are
  inconclusive; none is not found. An opened shipment must carry the service code and number it
  was opened under.
- The search finds an air and ocean job by its master bill too, such as an air waybill's eleven
  digits without the dash, but lists the job under its job number and house bill. The adapter
  then asks Mainfreight's app, `POST https://mobile.mainfreight.com/2.3/Tracker/Retrieve` with
  `{"permalink":"CW","reference":"{job}","brand":"MFT"}`, for the job's references, and opens
  the job only when they name the whole number as its master bill. Several jobs under one master
  bill, as in a consolidation, are inconclusive.
- An address the tracker does not know answers `[]`. A shipment the search lists but that does
  not open, or an empty body, is inconclusive. Some shipments answer HTTP 500 every time, which
  is inconclusive too.
- A 429 is a rate limit. A 403 or a firewall page, even with HTTP 200, is a challenge. A 404 or
  a redirect is a moved route.
- Recognition makes the same requests.

## Notes

- Transport scans in New Zealand, Australia and the United States give a clock with its zone's
  abbreviation, such as `AEST` or `PST`, so they become instants. European transport scans use a
  24-hour clock without a zone, and air and ocean milestones and container legs give the site's
  wall clock, sometimes a day alone. Those stay `local_time`.
- Air and ocean milestones marked `(Estimated)` have not happened and are left out. Their
  estimated delivery date, or a European shipment's expected arrival day, is the ETA.
- American scans name the place in their wording, followed by its ZIP code. The adapter takes
  the place off the wording into the location and drops the ZIP code. A transit row naming a
  leg, `TOWN to TOWN`, has no location.
- A cleared customs milestone puts the cargo back in transit. A container job's legs between
  sites are moves; the last leg ends with its final delivery.
- The reply's `statusDateUtc` is the status's wall clock, not UTC, so it is not used.
- Branch contacts, postcodes, the sender's reference, documents and the notification and
  watchlist keys in the reply are not kept.
- The site's hCaptcha guards its contact forms, not tracking.

## Limitations

- Customs declarations open without a status or a milestone, which is no history.
- The tracker has no recipient or proof of delivery. Air and ocean jobs have no delivery instant
  with a zone.
- The adapter removes spaces, dots and dashes from the number, so a sender's reference that
  keeps them in Mainfreight's records may not be found.

## Numbers

The tracker takes consignment, job, house bill, master bill and container job numbers, and
senders' references. Transport consignments in New Zealand, Australia, the United States and
Europe are eleven digits; air and ocean jobs are `S` and eight digits, and customs declarations
`B` and eight digits; container jobs are `CJ` and nine digits. Some senders' consignment
references are three letters and eight digits. Eleven digits are shared by many carriers, so
`mainfreight-1` only suggests Mainfreight, and recognition asks it only when the lookup's country
is New Zealand, Australia or the United States: in Europe, GLS prints the same eleven digits. The
job layout is common to freight forwarders on the same software, so no rule claims it. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker reads a number from `trackingnumber` on `/tracking`, the address its own search
form builds. A tracked shipment opens at `/track/` followed by a service code and the number.

## Testing

`npm run test:carriers:live -- carriers/mainfreight`, with `MAINFREIGHT_TRACKING_NUMBER` set
outside the repository to an eleven-digit transport consignment. Optionally set
`MAINFREIGHT_JOB_NUMBER` to check an air and ocean job, `MAINFREIGHT_MASTER_BILL_NUMBER` to check
one found by its master bill and `MAINFREIGHT_UNKNOWN_NUMBER` to check a number the tracker does
not know.
