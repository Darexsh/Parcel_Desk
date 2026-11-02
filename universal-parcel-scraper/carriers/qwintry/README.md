# Qwintry

Qwintry is a US parcel forwarder and fulfilment service. Its own air service, Qwintry Air,
carries parcels from its US consolidation hub by air to the destination country, where a local
delivery service takes over. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://logistics.qwintry.com/track?tracking={number}`, as the tracking
   form sends it. It needs no cookie, token, key or browser. The server-rendered page heads the
   history with the number, names the local carrier in a notice and lists the scans oldest
   first in a table.
2. `retry`: the same request once more after a network failure or a hang.

- An unknown number is the tracker's HTTP 404 page, `This tracking does not exist`. Another
  404, a 410 or a redirect is a moved route, and a bot check's page is a challenge.
- The tracker matches numbers in any case, but a lowercase lookup heads the page with an
  internal id. The adapter asks in capitals, and the page's heading must name the number asked.
- The account API's tracking call needs the account's bearer key, so the adapter reads the
  public page.
- Recognition makes the same request.

## Notes

- Each scan's clock is a wall clock to the second, with no zone. The API documentation's
  example gives Qwintry's own scans as Unix times that match the page's clocks read as UTC,
  but scans relayed from customs and the local carrier may carry the partner's wall clock, so
  every scan stays `local_time`.
- A scan's status code stages it, and wording recorded in [`statuses.json`](statuses.json)
  takes precedence. Relayed scans arrive under generic codes in English or Russian, and the
  shared classifier does not read Russian. A cleared or released parcel is in transit.
- Qwintry's scans name their place after the step, such as `Arrival scan:`; the courier
  service's terminal code is dropped and the consolidation hub is no place. Russian Post's
  scans end with the office in brackets, which becomes the location.
- Older histories put the courier service's `Planned delivery date` before its scans. The
  adapter strips it from the wording and gives the newest as the estimate until delivery.
- Once the parcel is booked with a local carrier, a notice names it and its number and links
  its tracker. The hand-off is set only when that link is CDEK's or Russian Post's tracker and
  carries the number shown. DPD Russia, Boxberry and IML are not in the catalog, so their
  notices give none.
- Phone numbers are removed from scans. The destination town, delivery type, batch and the
  delivery time in days on the page are not kept.

## Limitations

- No weight, service name or delivery time as an instant.
- The grid pages a long history from its oldest scans. The adapter reads one page and marks the
  history truncated when the grid counts more scans.

## Numbers

Qwintry's tracker shows its number as `QRXXXXXXXX`, and archived and live lookups show `QR` and
eight digits with whole histories. `qwintry-1` claims that layout. TNT Italy's low rule accepts
any two letters and eight digits, so it stays a suggestion there. The tracker also follows the
Russian Post number of a parcel Qwintry handed to the post, which the adapter reads; generic
postal detection keeps those numbers. Later histories also print the local carrier's own
number, while Qwintry's number keeps the whole history. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`logistics.qwintry.com/track?tracking={number}` opens one parcel. The library reads the number
from that link.

## Testing

`npm run test:carriers:live -- carriers/qwintry`, with `QWINTRY_TRACKING_NUMBER` and optionally
`QWINTRY_UNKNOWN_NUMBER` set outside the repository.
