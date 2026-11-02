# Airpak Express

Airpak Express is a courier founded in Singapore that also runs a Malaysian domestic network
and international express services. Its tracker is a GETOnline page that Frontier Force hosts
for it under the member id `stid=airpak`. Tracked through that page.

## How it works

1. `direct`: one `GET https://tracking.airpak-express.com/go/plm-tracking?stid=airpak&cn={number}`,
   the page the site's tracking box leads to. It needs no cookie, token, key or browser. The
   server writes the history into the page's script, newest first within each of the page's
   sections: for each scan the number, the event's wording and number, its location and its
   clock.
2. `retry`: one more attempt after a network failure.

- The page and its parser are the ones SkyNet Worldwide Express uses, shared in
  [`getonline.ts`](../skynet-worldwide/getonline.ts).
- An unknown number gets the page's "No tracking found" notice. A 404 or a redirect is a moved
  route, an empty page is inconclusive and a firewall page is a challenge.
- Every scan must name the number asked.
- Recognition makes the same request.

## Notes

- `stid` picks Airpak's records as well as its branding: another member's id does not find an
  Airpak connote. The adapter sends only `airpak`.
- The tracker answers more than whole numbers, so the adapter sends only a whole connote
  number.
- Each scan's clock is the station's wall clock to the minute, with no zone. Scans in Singapore
  and Malaysia are dated on their clock, UTC+8 all year; a scan in a country with several zones
  would stay `local_time`.
- The event number stages a scan. The documents prepared before the collection are a
  registration. A hold in the depot moves nothing.
- The destination's state, the service type, the sender's reference and the masked signatory
  are not kept. The proof of delivery, behind a check of the recipient's phone number, is not
  read.
- The site's tracking box opens `tracking_search.aspx`, whose search page asks the tracker's
  summary lookup and opens this page when it finds one shipment. The adapter reads the page
  directly.

## Limitations

- No ETA, weight, service name or delivery time as an instant.

## Numbers

Connote numbers are twelve digits, mostly starting 200 and also 100, 400 and 800, and eleven
digits starting 810. Bare digit runs of these lengths are printed by many carriers, so no rule
claims them and preflight does not ask Airpak: a number reaches the adapter when the user, a
link or a provider names the carrier. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The site's tracking box opens
`tracking.airpak-express.com/tracking_search.aspx?stid=airpak&cn={number}`, which redirects to
`go/plm-tracking_search` on the same host. Older lookups put the number in `cn` on
`airpak-express.com/tracking/`, which now redirects to the search page. The library reads the
number from `cn` on these addresses.

## Testing

`npm run test:carriers:live -- carriers/airpak-express`, with `AIRPAK_EXPRESS_TRACKING_NUMBER`
and optionally `AIRPAK_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
