# C Chez Vous

Bulky retail orders delivered in France on a booked appointment or to a pickup point. Tracked
through the public order page, which shows an order (one or more parcels on a progress bar),
not a parcel journey.

## How it works

1. `direct`: one bounded `GET https://www.cchezvous.fr/suivi-colis/{reference}` with
   `redirect: 'manual'`. The server-rendered page embeds the whole order record as JSON in
   `<tracking :tracking-results="…">`; `parse()` reads it. No session, token or second request.
   - 404 or any 3xx is not-found: an unknown order is redirected back to the tracking form.
   - Other non-2xx is `UpstreamHttpError`.
   - "commande introuvable" in the page is not-found.

Accepted references, uppercased with spaces removed:

- an 8–15 character order reference containing a digit;
- an 11-character order + `--` + French postcode. Shared normalization strips punctuation, so
  the compact 16-character form is restored to the `--` form. An invalid postcode is rejected
  before any request.

## Notes

- Detection names C chez vous for four letters, two digits and four letters or digits only at
  low confidence, so recognition asks the order page. Other carriers' generated numbers, such
  as Hovership's, fall inside that shape. The page's example ends in letters, and four letters
  followed by six digits are other carriers' consignment numbers, so a reference ending in four
  digits is left out.
- The order reference alone opens the page, so it is a credential: never log it, quote it in
  an issue or commit a real one.
- The reference is checked against both the embedded `package_number` and the one printed in
  the heading — a stale or generic render of the app shell would otherwise pass for the wrong
  order.
- The order's step is the least advanced of its parcels. Reporting a half-delivered order as
  delivered would stop notifications for the rest.
- The page's script titles and explains each step. A home delivery has five. Step 4, titled
  "En livraison", is the trip to the regional platform before the appointment, so it is
  `in_transit`, not out for delivery. Step 2 ("Prise de rendez-vous") is still `registered`:
  the appointment is being booked, nothing has shipped.
- A pickup-point order (`delivery_type` `EMP`) has no appointment step and six steps: step 5 is
  the order waiting at the point (`ready_for_pickup`) and step 6 its collection. Reading its
  step 5 as a home delivery's would report it delivered before it is collected.
- A `parcelStep` its order's set does not list makes the whole order `unknown` with no stage,
  so the sync records it for review. Clamping it to step 1 would claim the order has not
  started.
- The estimate is the latest parcel appointment day, dropped once delivered. The time window
  (`dateMessage`) is discarded on purpose.
- `history` is not declared: the page has no scan history and the single event restates the
  current step.
- `pickupName` is the person receiving the order, not a parcel shop, so `pickup_point` is not
  declared.
- The record also carries shop, recipient name, address, phone, e-mail and ordered articles.
  Only the delivery type, the step and the appointment date are read; a test asserts none of
  the rest reaches the result.

## Limitations

- No scan history, locations, failure or return steps. A cancelled or failed order simply
  stops advancing.
- Day-resolution estimate only.

## Testing

`npm run test:carriers:live -- carriers/c-chez-vous` (no env vars). The two
examples C Chez Vous prints under its tracking form are retired orders; the test asserts they
return not-found.
