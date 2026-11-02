# Evri

Evri International, through the [GlobalEco tracker](https://globaleco.app/track/)
that the official Evri tracking page links for international parcels. Domestic
UK tracking is a separate [Evri UK](../evri-uk/README.md) service with its own
browser adapter. A not-found here says nothing about Evri UK. Detection checks
the 16-character barcode's last digit as described there, and lists Evri
International first for a `C` in the sixth place.

## How it works

1. `direct`: one anonymous form POST to `https://globaleco.app/track` with
   `tracking_number`. No cookies, CSRF token, postcode or browser. 15-second
   default deadline (a smaller caller budget and cancellation are honoured),
   1 MB response cap, no retry.

## Notes

- Identity is the requested number in both the `Shipment Details #…` heading
  and the **System Tracking** field. The echoed search input is ignored: the
  portal can replace it with the partner's tracking number.
- The **Carrier** field names the network delivering the parcel abroad and
  **Carrier Tracking** holds that network's number. The result names it as
  `delivery_carrier` and `delivery_tracking_number` only when the parser's label
  table maps the label to a catalog carrier and that carrier's detection offers
  the whole number. Evri's own courier labels, a label the table lacks and the
  barcode repeated in Carrier Tracking name nobody. OSM Worldwide's line names
  USPS, which delivers its parcels under the USPS barcode Carrier Tracking holds.
- The tracker also finds a parcel by that partner number, but this adapter asks
  only by the Evri barcode. A partner's number belongs to the partner: Paack
  reads this tracker for the numbers it gives these parcels (see
  [Paack](../paack/README.md)).
- Aggregators call this tracker "Global Eco" or "GlobalEco"; both are aliases
  of Evri. When an aggregator reports one of these names for a number another
  carrier's rule claims at high confidence, the hint goes to that carrier
  (`core/catalog/partners.ts`), so a Paack number is not filed under Evri.
- Recognition makes the same POST: a parcel with scans is known, and the
  **Parcel not found** heading is unknown.
- Not-found is only the explicit **Parcel not found** heading on the normal
  search form, returned with HTTP 200. That form clears its input, so the POST
  itself scopes the answer; an input naming another number is rejected. A
  404/410 means the endpoint is gone and is a transport error.
- Changed markup, a missing history table or ambiguous identity are schema
  errors.
- Each event is classified by its exact English label. Unknown labels stay
  visible without a stage, and an unknown current label gives `unknown` status.
- Timestamps have no offset or documented zone, even for partner scans abroad.
  They are kept as offset-less `events[].local_time` and `last_update_local` in
  the portal's newest-first order; `events[].time` is omitted and `last_update`
  is null, so the host never reads them as UTC. Clocks aren't sorted across
  legs.
- Because of that, the host first checks universal providers for a dated
  timeline and uses this result as the fallback. It can establish initial
  progress but can't overwrite a richer summary, and it doesn't feed the
  timeline of confirmed instants. The host keeps these scans in a bounded
  `direct_local_history` archive across later universal refreshes. No delivered
  time is inferred.
- A row's comment can state the delivery estimate, month first ("Estimated
  delivery date is: 10-30-2026"). The newest one is `expected_delivery` until
  the parcel is delivered or returned.
- Exact duplicate scans are removed; at most 100 are returned.

## Limitations

- International only; domestic UK numbers use the Evri UK adapter.
- Sender names, destination and outbound links are never read, nor is anything
  in a comment but a delivery estimate.

## Testing

`npm run test:carriers:live -- carriers/evri`. The not-found
check needs no env vars; the positive check runs when `EVRI_TRACKING_NUMBER` is
set outside the repository.
