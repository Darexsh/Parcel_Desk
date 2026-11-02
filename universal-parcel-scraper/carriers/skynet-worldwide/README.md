# SkyNet Worldwide Express

SkyNet Worldwide Express is a network of independently owned express couriers. Its members
share a tracker hosted by Frontier Force, which picks the network's branding from
`stid=skynet`. Skynet Malaysia shares the name but is a separate company, and aggregators often
mix the two. Tracked through the network's tracking page.

## How it works

1. `direct`: one `GET https://tracking.frontierforce.com/go/plm-tracking?stid=skynet&cn={number}`,
   the page `tracking.skynetexpress.com` serves under its own name. It needs no cookie, token,
   key or browser. The server writes the history into the page's script, newest first: for each
   scan the number, the event's wording and number, its location and its clock.
2. `retry`: one more attempt after a network failure.

- An unknown number gets the page's "No tracking found" notice. A 404 or a redirect is a moved
  route, an empty page is inconclusive and a firewall page is a challenge.
- Every scan must name the number asked.
- The request and the parser serve the other couriers on GETOnline too, each under its own
  `stid`, from [`getonline.ts`](getonline.ts).
- There is no recognition: no detection rule offers SkyNet, so preflight never asks it.

## Notes

- `stid` picks the network's records as well as its branding: another member's `stid` does not
  find a SkyNet shipment, and the page without one is empty.
- Each scan's clock is the scanning station's wall clock to the minute, with no zone. A scan is
  dated in its country's zone when the country keeps one clock, the Canary Islands and the
  Azores apart from their mainland; anywhere else it stays `local_time`. The tracker's summary
  lookup gives a UTC field, but its offsets are wrong for North America.
- The event number stages a scan. Holds in branch, returns to the sending station and messages
  to the recipient move nothing.
- The destination's town, the service type, the masked signatory and the references are not
  kept.
- `POST go/plm-tracking_search` with `action=gettrack-summary` answers the newest scan only, so
  the adapter reads the page.
- A run of zeros is a placeholder, not an air waybill, and is refused without a request.

## Limitations

- No ETA, weight, service name or delivery time as an instant.
- Scans in countries with several zones, such as the United States and Canada, stay wall
  clocks.

## Numbers

SkyNet air waybills are mostly twelve digits, some with leading zeros; aggregators also show
eleven digits and lettered labels that may belong to Skynet Malaysia. None of these points to
SkyNet alone, so no rule claims them, and the gap is declared in
[`gaps.json`](../../core/detection/gaps.json). The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker reads a number from `cn` on `tracking.skynetexpress.com/go/plm-tracking`, and from
the same path on `tracking.frontierforce.com` when the link's `stid` is `skynet`: that host
serves the other GETOnline couriers under their own `stid`. The network's site at
`skynetworldwide.com` sits behind a bot challenge.

## Testing

`npm run test:carriers:live -- carriers/skynet-worldwide`, with
`SKYNET_WORLDWIDE_TRACKING_NUMBER` and optionally `SKYNET_WORLDWIDE_UNKNOWN_NUMBER` set outside
the repository.
