# GlobalPost

GlobalPost is Auctane's cross-border consolidation service, sold through ShipStation in the
United States and the United Kingdom. It collects parcels at its own facilities and hands them
to a national post or courier in the destination country, whose number the tracker also shows.
Tracked through the page its tracker renders for one number.

## How it works

1. `direct`: one `GET https://www.goglobalpost.com/track-detail/?t={number}`, the address the
   site's tracking form opens. It needs no cookie, token, key or browser. The site renders the
   page on its server: one card with the newest status, the route, the GlobalPost number, the
   final-mile partner and its number, the service and the scans, newest first under a heading
   for each day.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- A number the tracker holds nothing for is redirected to its search page with the same number
  and `status=not_found`, which is not found. A redirect for another number or without that
  status is inconclusive, and one elsewhere, a 404 or a 410 is a moved page. A bot check's page
  is a challenge.
- The page repeats the number it is asked, and also opens a parcel by its partner's number. The
  adapter asks only for GlobalPost's own numbers, and the card counts only when its id and the
  GlobalPost number it shows are the number asked; a page for another number or for several
  parcels is inconclusive.
- The site caches a found page for a few minutes, so a scan can show up late.

## Notes

- Scan clocks are wall clocks without a zone, on the clock of the place that scanned, and the
  page's order stands. On a parcel sent from the United States, the scans on its way out whose
  place settles that clock get its state's zone. GlobalPost's facility scans at ePost Global's
  processing centers, written "Town ST", are ePost Global's own to the minute, on the center's
  clock; the facilities Asendia runs, written "Town, ST", keep their wall clocks. USPS's scans
  match Canada Post's and Japan Post's times for USPS's exchange offices. A scan at a facility
  USPS names counts anywhere on the way out, and one at a town written "TOWN,ST" only before
  GlobalPost has the parcel, since posts abroad write their towns the same way.
- A state with two clocks gives no zone, nor does a code that also names a single-clock
  country, such as IL, unless the town is the state's. Midnight sharp is a day without its
  time. The registration, scans without a state, the delivery abroad and a return keep
  `local_time`: Canada Post's scans name no province, and partners' scans relayed through
  Asendia come on the partner's clock or in UTC. The newest scan's instant is the last update.
- GlobalPost relays its partners' scans in its own wording, without codes; the wordings are
  mapped and any other goes to the shared wording rules. Arrival at a GlobalPost facility is its
  acceptance, though USPS scans on the way there can come first. Cleared customs puts the
  parcel back in transit. A registration listed after the parcel moved is no step back. A
  scan's wording can carry the tracker's note that updates may take time; the map reads the
  wording before it, and the description keeps both.
- Places are cut at their first word holding a digit, where the page puts the shipper's ZIP
  code or a facility's cut-off one. "Not Available" is no place.
- The final-mile partner is named only when the catalog knows its exact name and its link, if
  any, is its own; otherwise only its number is kept. The partner's number is the delivery
  tracking number; a USPS routing barcode loses the ZIP code it opens with.
- A parcel sent back to its sender ends with "Delivered", and the page's heading puts that
  delivery at the recipient's town. The scan's own place is the sender's town, as Canada Post's
  return scans for the same parcel confirm. A delivery scan at the sender's town, when sender
  and recipient are in different countries and towns, is `returned`.
- The service and the destination country are kept. The recipient's and shipper's towns, read
  to tell a return, the shipper's country, read for an `SDC` number's origin, the shipper's ZIP
  code and the progress rail are not.

## Numbers

GlobalPost's own numbers start with `GP`, four letters naming the service and ten digits, and
end with `US` or `GB` for the origin; `globalpost-1` claims that layout, which no other carrier
uses. Older parcels carry `SDC` and fifteen digits, which the adapter accepts but which are too
rare in public sources to claim. The tracker also finds parcels by USPS-issued S10 numbers on
some services and by the final-mile number; postal detection routes those to their carrier, and
the adapter does not ask for them.

## Links

The tracking form opens `goglobalpost.com/track-detail/?t={number}`; archived lookups also
use `t` on `goglobalpost.com/track/`. The library reads the number from either address.

## Limitations

- No delivery estimate, delivery time, weight or proof of delivery.
- A return delivered at a place other than the sender's town, or without a place, stays
  delivered; the page has no return wording.
- Expired parcels get the unknown-number answer.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.
Explicit absence redirects must name the whole requested number on the carrier’s tracking site.
A bot check on the redirected page stays a challenge.

## Testing

`npm run test:carriers:live -- carriers/globalpost`, with `GLOBALPOST_TRACKING_NUMBER` and
optionally `GLOBALPOST_UNKNOWN_NUMBER` set outside the repository.
