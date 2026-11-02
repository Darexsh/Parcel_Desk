# ShipEntegra

ShipEntegra is a Turkish cross-border shipping company for online sellers. It takes parcels in
at its own Istanbul transfer centre and sells UPS, FedEx and DHL labels, whose numbers belong
to those carriers. Its own line carries ShipEntegra numbers and hands parcels to a partner
carrier for delivery abroad. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://track.shipentegra.com/track_service.php` with the form field
   `tracking_number` set to the number's nine digits, as the tracking page sends each number
   typed in. It needs no cookie, token, key or browser. The JSON reply, served as `text/html`,
   has the tracker's status for the shipment, its destination, the carrier that takes it on and
   the scans, newest first.
2. `retry`: the same request once more when the first did not reach ShipEntegra or hung. The
   first gets half of the budget.

- The lookup refuses the 1SE prefix with HTTP 400 and `{"status":false,…}`, which the page
  shows as an empty card. The adapter sends the nine digits, and the reply must echo them.
- An unknown number is HTTP 200 with the status `NOTFOUND` and no scans, and the tracker echoes
  it as an integer. A 404 or a redirect is a moved route.
- After fifty lookups the page asks the browser to copy a text it draws. The check runs in the
  page only; the lookup does not ask for it.
- Recognition makes the same request.

## Notes

- A scan's `date` is a wall clock to the minute, with no zone. ShipEntegra's own scans in
  Istanbul and its partners' scans abroad share the field, so the clocks stay `local_time`.
- The summary's `delivery_date` can be an hour off the delivered scan and is also set on parcels
  still in transit, so it is not read. `first_date` is the label scan's clock read as UTC.
- ShipEntegra words its own three scans. Its partners' scans come as one of the tracker's fixed
  sentences, often followed by the partner's own words, as in
  `Package is out for delivery.En Route`. The sentence stages the scan: the shared rules read
  some of those endings as another stage. Wording loses a clause naming who signed for or took
  the parcel, and phone numbers.
- The tracker's status (`status_description`, else `realCarrierStatusDescription`) decides a
  delivery, a return or an exception, and stands in when no scan has a stage. Otherwise the
  newest scan with a stage decides.
- `last_mile_carrier` and `last_mile_tracking_number` name the carrier that takes the parcel on.
  The adapter names it as the delivery partner when the page links its number to that
  carrier's own tracker (UPS, FedEx, USPS, DHL Express, DHL eCommerce, TNT) and that carrier's
  detection rules offer the number. Widect's tracker takes the delivering carrier's number,
  which the reply does not name, so a Widect leg has no hand-off. The catalog does not know
  DirectLink or Yodel, and `SE` is ShipEntegra itself.
- The seller's account id in the reply is not read. The page shows scan places for a few
  sellers' parcels only, and the adapter does not read them.

## Limitations

- No weight, estimate, service or delivery time as an instant.
- The tracking page sends the number as typed, so a portal link with the 1SE prefix opens a
  page without a result.
- A parcel on a UPS, FedEx or DHL label shows only ShipEntegra's own scans here; the delivery
  partner's tracker has the rest.

## Numbers

ShipEntegra numbers are 1SE followed by the nine-digit label number, and customers also quote
the nine digits alone, which is how the tracker looks parcels up. Rule shipentegra-1 claims 1SE
and nine digits with high confidence. The bare nine digits stay unclaimed because many
carriers use short digit runs; the adapter takes them when ShipEntegra is chosen.

## Links

One parcel opens on track.shipentegra.com with the number in the `trackno` parameter. The
tracker's share link builds that address from the current page, and the tracker also reads
several numbers separated by commas or spaces from it. The library reads the number from it.

## Testing

`npm run test:carriers:live -- carriers/shipentegra`, with `SHIPENTEGRA_TRACKING_NUMBER` and
optionally `SHIPENTEGRA_UNKNOWN_NUMBER` set outside the repository.
