# Early Bird

Tracks parcels of Early Bird, the Swedish morning and evening home-delivery network, through the
service its tracking page asks.

## How it works

`earlybird.se/spara-och-hjalp` asks `POST https://earlybird.se/api/tracking` with the number and
the page's language, without an account, key, cookie, postcode or CAPTCHA token. The adapter
sends the same body in English. A request that fails to reach Early Bird is sent once more within
the budget.

An unknown number comes back as HTTP 404 with the code `tracking_not_found`, so it is not found. A
number the service refuses is invalid input. A rate limit, Vercel's checkpoint, block pages, a
missing route, other refusals and malformed replies keep their own failure kinds. Recognition uses
the same lookup.

## Numbers

The page takes eight to thirty letters and digits, and the service does not check an SSCC's check
digit. The adapter takes the same and refuses a twenty-digit SSCC starting `00` whose GS1 check
digit fails, without a request. The service does not know the eighteen-digit form without `00`.

Archived lookups on both of Early Bird's trackers and the samples a tracking aggregator offers for
it share one serial sequence under the GS1 company prefix `73402216`, its serials rising with
time, and the service answers them. `early-bird-1` suggests Early Bird for SSCCs under that
prefix first, and preflight asks it. PostNord's broader rule for Nordic SSCCs also lists PostNord,
which takes some parcels over under the same number, after it; Bring's rule leaves the prefix out. An SSCC under another prefix names whoever issued it, so no rule offers Early Bird for it.

## Notes

The reply does not echo the number, so its scans belong to the number asked for. A `timeline`
lists at most the newest twenty scans, each with a clock and wording but no code; the adapter
marks the history as cut when twenty come back. Current parcels carry UTC instants and English
wording. Parcels from Early Bird's earlier system come in Swedish whatever the language, with
wall clocks without an offset, which stay local.

An arrival names a terminal or a route. A town becomes the scan's location, without Early Bird's
name before its own terminals; a name with a digit is a route or a dock and stays in the wording
only. A new delivery attempt booked after a failed round keeps the stage before it. The map stages
the failed-round wordings itself, as one of them promises that the parcel will be delivered.

An `external_link` reply has no scans: the parcel was handed over to PostNord, DSV or DB Schenker,
whose tracking page the link opens. The page follows only those three origins. The adapter names
the partner as the delivery carrier, which tracks the parcel under the same number.

## Limitations

No live reply was an `external_link`. The service no longer knows some older parcels, which come
back like unknown ones; a nineteen-digit `999` number of the earlier tracker came back the same
way. The earlier tracker on `track.earlybird.se` asks `api.earlybird.se/kolibri`, which needs the
per-recipient code its links carry. `tracking.earlybird.se` now forwards to an unrelated site.

## Links

Early Bird's tracker at `earlybird.se/spara-och-hjalp`, and its English page at
`earlybird.se/en/track-and-help`, read the number from the `id` parameter and look it up when the
page opens; the older `earlybird.se/tracking/` address forwards there with the parameter. Links
from its earlier tracker on `track.earlybird.se` carry the number in the `a` parameter. The library
reads all of them.

## Live test

Set `EARLY_BIRD_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/early-bird/adapter.live.test.ts`.
Optionally set `EARLY_BIRD_UNKNOWN_NUMBER` to check a number the service does not know.
