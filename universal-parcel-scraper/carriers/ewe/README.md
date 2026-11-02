# EWE Group

EWE Group is a Sydney logistics company that delivers e-commerce parcels across Australia from
its own warehouses, for marketplaces such as SHEIN, eBay, Amazon and Temu. eMetro is its
delivery arm. Tracked through the lookups its two trackers make.

## How it works

1. `direct`: two requests at once. Neither needs a cookie, token, key or browser.
   - `GET https://trace.ewe.com.au/api/trace/orderRoute?orderNo={number}`, the lookup of EWE's
     trace tracker. It knows the parcels of EWE's delivery system, such as Amazon-channel ones,
     and gives each scan an `action` code, its time in UTC with the site's offset, and the
     suburb.
   - `GET https://www.epintl.com.au/oms/api/tracking/emetro/{number}`, the lookup the tracking
     page on www.ewe.com.au makes. It also knows eMetro's consignments, and relays the delivery
     system's scans with wall clocks and without codes or places.

   The trace answer wins when it has the parcel, and the other request is cancelled. Otherwise
   the tracking page's answer stands: found, not found or failed.
2. `retry`: a lookup that fails to reach the trackers, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The tracking page's lookup answers an unknown number with HTTP 200, no scans and a status
  saying it couldn't find the number, which is not found. The trace tracker's "Order does not
  exist" alone proves nothing, as it does not know eMetro's consignments.
- A 429 is a rate limit, a 403 or a bot check a challenge, and a redirect or a 404 a moved route.
- The tracking page's lookup also finds a consignment by one of its article numbers. Its reply
  must name the number asked, as the consignment or one of its articles; the trace reply must
  name it on every scan.
- No recognition: no rule claims EWE's numbers.

## Notes

- The trace lookup's client and parser, in [trace.ts](trace.ts), also serve
  [HOMEXPRESS](../homexpress/README.md): one server answers both trackers from one database.
- Trace scans keep their instant with the site's offset. The reply's wall clock must agree with
  it, or the tracking page's answer is used instead. The tracking page's scans are wall clocks
  to the minute with no zone, and EWE's sites are in more than one time zone, so they stay
  `local_time`.
- The tracking page's lookup lists eMetro's scans newest first and relayed ones oldest first;
  the adapter orders both by clock.
- A trace scan is staged by its `action` code. The tracking page's scans have none: eMetro's are
  staged by their wording, and relayed ones by their opening words, since they name the depot or
  warehouse. "Fully Complete", eMetro closing the consignment after the delivery, moves nothing.
- The out-for-delivery scan names the driver, whose name is dropped, as are phone numbers. The
  suburb and state are kept as the location. The postcode, the delivery coordinates and proof
  photos, the sender's and recipient's suburbs, the article numbers and their count are not.

## Limitations

- No delivery estimate, weight or service name.
- eMetro's consignments have wall clocks only.

## Numbers

Archived lookups on EWE's trackers show three layouts, each with a single number: AMZ and ten
digits for an Amazon parcel, EMC and eleven digits, and an older E, nine digits and E. Neither
prefix names EWE and HOMEXPRESS runs the same tracking software, so no rule claims them and
detection does not offer EWE.

## Links

`ewe.com.au/pages/tracking-order` with `cno` opens one parcel; the page reads the number only
when the address also has a fragment, which its own result links add. The older
`ewe.com.au/html/track.html` took the same `cno`. The second tracker at `trace.ewe.com.au`
opens one parcel with `no`.

## Testing

`npm run test:carriers:live -- carriers/ewe`, with `EWE_TRACKING_NUMBER` (a parcel the trace
tracker knows) and optionally `EWE_EMETRO_NUMBER` and `EWE_UNKNOWN_NUMBER` set outside the
repository.
