# Jersey Post

Tracks items posted in Jersey under UPU S10 numbers ending in `JE`, through the lookup Jersey
Post's own tracking page makes. Once an item has left Jersey, the tracker relays the scans of the
post abroad.

## How it works

1. `direct`: one `POST https://www.jerseypost.com/Umbraco/Surface/Tools/Track/` with the body
   `{"query":"{number}","sentFromJsy":""}`, as the page's search button sends it. It needs no
   cookie, token, key or browser. A read that fails to reach the site, or hangs, is sent once
   more (`retry`) within the budget.

- The reply's `data` holds one item per number asked, and its `result` says what the page shows:
  `1` a history, `3` "No tracking information available", `2` and `4` a number the tracker does
  not take, `5` another carrier's number, `6` a question whether the item was posted in Jersey and
  `-1` a refused request. `3` is not found; the tracker gives it for expired items too. `5`, `6`
  and `-1` are inconclusive.
- The item must name the whole number and Jersey Post as its carrier. For other carriers' numbers
  the tracker answers `1` with no history and a link to their site.
- A 404 or a redirect is a moved route. A firewall page in place of the JSON is a challenge.
- Recognition makes the same request.

## Notes

- Jersey Post's own scans have no place and a clock to the second. Relayed scans name the country
  they happened in, which is kept as their place.
- The reply names no zone. Against another feed for the same item, Jersey's clocks and the
  relayed ones alike matched UTC rather than the scanning office's wall clock, so neither Jersey's
  zone nor the scanning country's applies. Every clock stays in `local_time`.
- The status codes are `1` on every scan and on the summary, delivered or not, so only the wording
  stages a scan. A failed delivery can carry its reason after a dash; the wording before it gives
  the stage. "Item received at inbound office of exchange" is the destination's office of
  exchange, not an acceptance, which the shared wording rules would read.
- "Awaiting Item from sender" can come twice, days apart, before the item is despatched, so it
  stays registered.
- The proof of delivery (`pod`) names who signed and is not read. The reply names the country
  abroad but not the destination post's own number, so there is no hand-off.

## Limitations

- No delivery estimate, service, weight or scan instant.
- The adapter does not answer the tracker's question whether an item was posted in Jersey.

## Numbers

Jersey Post's tracker covers items posted in Jersey on a tracked service and asks for UPU S10
numbers ending in `JE`. Lookups archived from it and an aggregator's sample show them. The adapter
takes those with a valid check digit and rejects anything else without a request. The issuer of
an S10 number does not establish who delivers it, so detection keeps them with the generic postal
carrier and the low-confidence `jersey-post-s10` rule makes preflight ask Jersey Post about them.
Numbers starting `UM` belong to an untracked service, though the tracker still relays the scans
of the post abroad for them. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker's search form sends the number as `tq` to `jerseypost.com/tools/track-trace/`, and
the page it returns shows that item, so `jerseypost.com/tools/track-trace/?tq={number}` opens
one parcel. Archived lookups use the same address with and without `www`.

## Testing

`npm run test:carriers:live -- carriers/jersey-post`, with `JERSEY_POST_TRACKING_NUMBER` and
optionally `JERSEY_POST_UNKNOWN_NUMBER` set outside the repository.
