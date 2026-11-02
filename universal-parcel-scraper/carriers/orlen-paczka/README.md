# ORLEN Paczka

Tracks parcels of ORLEN Paczka, the Polish pickup point and locker network formerly called
Paczka w RUCHu, through the status service its own tracking page calls.

## How it works

One anonymous GET to `https://nadaj.orlenpaczka.pl/parcel/api-status?id={number}` returns the
parcel's scans as JSON wrapped in `callback(...)`, the JSONP call the tracking page's script
(`track.dist.js` on `www.orlenpaczka.pl/sledz-paczke/`) makes. No session, cookie, key or
browser is needed.

The reply must name the requested number as the number asked about and as the parcel
(`truckNo`). Absence is the service's own placeholder: no parcel (`Brak danych`) and no scans.
Error 1004, which some numbers of the current range return, stays inconclusive: the tracker
shows them as untrackable without saying whether a parcel exists. HTTP recognition uses the
same lookup. The official app (`pl.orlen.paczka`) talks to a separate API at
`api.orlenpaczka.pl`, which this route does not need.

## Numbers

Lookups archived from the tracker since 2021 show thirteen digits starting `210` and ending in
a GS1 check digit, the series rising over time. `orlen-paczka-1` suggests ORLEN Paczka for that
layout at low confidence, because several carriers match thirteen digits broadly. Delovye
Linii's numbers can start `210` too, but none archived passes the check, so a passing check
digit puts ORLEN Paczka first wherever the parcel comes from. The adapter takes
thirteen characters starting `2` or `3`, as the tracker's script does, and rejects a `210`
number whose check digit fails. The script also takes seven- and ten-digit sending codes,
the sender's drop-off codes rather than parcel numbers; the adapter does not look them up.
Parcels sent through Allegro Delivery, numbered from `AD`, are tracked at Allegro.

## Notes

Scan clocks are Polish wall time without an offset. They are read in `Europe/Warsaw`: every
scan comes from a point or sorting centre of the Polish network, and the service stamps its
own current time in that zone. A wall clock the zone repeats or skips stays local.

Each scan has a numeric code, a short category and a sentence. The sentence is kept as the
scan's wording and the code sets its stage; parcels of some services carry an older sentence
for the same code. A parcel handed to another country's carrier arrives under the code and
category of a parcel waiting at its point, so that wording, or a shorter one saying the parcel
is in another country, keeps it in transit. The town a
sorting-centre scan names becomes its location. A code the map does not know keeps its
wording without a stage. When the reply says its history is not `full`, the official page
shows the newest scan alone and the result is marked partial.

## Limitations

The reply has no pickup point, recipient, sender, weight or delivery estimate. It can name a
return parcel under a number of its own, which the adapter does not follow. The site's firewall
can refuse a request with an HTML page, which is read as a challenge, not a missing parcel.
Delivered parcels drop out of the tracker after some months.

## Links

ORLEN Paczka's tracker opens one parcel at `www.orlenpaczka.pl/sledz-paczke/?numer={number}`,
the address its copy-link button builds and the shape of the archived lookups.

## Live test

Set `ORLEN_PACZKA_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/orlen-paczka/adapter.live.test.ts`.
Optionally set `ORLEN_PACZKA_UNKNOWN_NUMBER` to check an absent parcel.
