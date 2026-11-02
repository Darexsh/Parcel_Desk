# Leopards Courier

Leopards Courier carries documents, parcels and cash-on-delivery orders between its stations across
Pakistan. Tracked through the lookup the tracking box on its site makes.

## How it works

1. `direct`: `GET https://pk.leopardscourier.com/shipment_tracking-new?cn_number={number}`, as the
   tracking box's script sends it. For a consignment the site knows, the reply is
   `{"success":true}` and the site keeps the consignment in the anonymous session the reply sets as
   a cookie. A `GET /shipment_tracking_view` with that session cookie then renders the tracking
   page on the server. It needs no account, key, CAPTCHA token or browser.

- A number the site has no record of is answered with the tracking page and its notice that the
  query about the number "appeared to be invalid / record not found". That notice, naming the
  whole number, is the only missing consignment. A notice for another number, a reply of
  `{"success":false}`, a lookup without a session cookie and a tracking page that holds no
  consignment are inconclusive.
- The tracking page must name the requested consignment. Redirects and 404s are a moved route;
  block pages, HTTP errors and malformed pages keep their own failure kinds. Failures carry no
  request or response details, as those hold the session.
- The page's script also sends its form token, which a lookup does not need.
- Recognition makes the same requests.

## Notes

- Scans are dated with a date and a minute without an offset. Leopards' network is in Pakistan,
  which keeps one offset without daylight saving, so every clock is read in Karachi time.
- Scans read as an action and the city it happened in, as `Inter Transfer at KARACHI`. The city
  is the location. A pending delivery gives its reason in capitals instead.
- A delivery's wording goes on to name who took the parcel and their relation to the consignee,
  as `Delivered at CITY NAME ~ STAFF`. The name is cut when it is the one the page's "Signed for
  by" line gives; otherwise only the wording before the city is kept. The signatory is not kept.
- `Assigned to Leopards in CITY` comes shortly before a delivery in the same city: the courier
  taking the parcel out, whom the page names as Leopards. It reads as out for delivery.
- The tracker pads a nine-digit number with a leading zero and shows the consignment under the
  padded number, which the result gives as the canonical number.
- The origin and destination, shipper, consignee, reference, booking date and piece count are
  not kept. The progress bar is not read.

## Limitations

- The page names no service, weight or expected delivery date.
- A consignment answers as unknown until its first scan, and older consignments drop out of the
  tracker. Returns and consignments sent abroad have not been seen.

## Numbers

Leopards tracking numbers seen on its trackers are two letters followed by nine or ten digits.
Many carriers print two letters and nine or ten digits, so no rule claims them; a caller names
the carrier or pastes a tracking page link.

## Links

The search box on pk.leopardscourier.com keeps a found parcel in the session, so no address
opens one parcel. A failed lookup opens `/shipment_tracking_view` with the number in
`cn_number`, and the library reads the number from that address.

## Testing

`npm run test:carriers:live -- carriers/leopards-courier`, with `LEOPARDS_COURIER_TRACKING_NUMBER`
and optionally `LEOPARDS_COURIER_UNKNOWN_NUMBER` set outside the repository.
