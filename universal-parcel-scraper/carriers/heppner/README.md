# Heppner

French groupage and palletized-freight network. Covers recipient shipments in France,
Switzerland, Belgium and Luxembourg through the `myportal.heppner-group.com` recipient portal. A
lookup needs the 8-digit receipt number plus the delivery postcode: five digits for France, four
for the other three.

## How it works

1. `direct`: two bounded requests on `myportal.heppner-group.com`.
   1. `GET /api/recipient/search/expedition?zipCode=…&receipt=…&countryCode=…` returns a
      base64 capability encoding `receipt&postcode&country`. The adapter decodes it and
      requires it to equal what it sent; a capability for another shipment is a
      `SchemaError`. A four-digit postcode is asked as Swiss, then Belgian, then Luxembourg:
      the portal's form takes any country and answers 404 for a shipment it holds under
      another.
   2. `GET /api/recipient/search/detailexpedition?expedition=<capability>` (with
      `Referer: /tracking/<capability>`) returns an array of shipments; the one whose
      `receipt` matches is parsed.
   - A 404 from every country's search, a 404 on the detail request, or an empty array is
     not-found. Any other failure of one country's search leaves the answer open.

## Notes

- The postcode is half of the lookup key, so it is a credential: never log it, put it in a
  fixture or an issue. With no postcode the factory raises `InputRequiredError` instead of
  calling the portal.
- The search call can't be skipped: the detail endpoint only accepts the capability it issues.
  A capability is not reused across lookups — it encodes one shipment and buys nothing.
- Detection (`^\d{8}$`) is low-confidence: it collides with Mondial Relay and others, so the
  user confirms the carrier.
- The endpoint sends identifiers, no wording. `step` (milestone) is read first, then the event
  code prefix, so a new code inside a known milestone still lands on the right stage.
  `status.ts` supplies the English descriptions.
- The parcel app's review (`statusMap`) reads that English description, since a stored scan
  keeps its code but not its milestone or state. "Heppner tracking update", the description of
  a scan no rule reads, stays open there.
- `EN_ATTENTE_INSTRUCTIONS` (awaiting delivery instructions) and the shipment state
  `ANOMALIE` map to `exception`.
- The `SOL_` codes close the shipment for different reasons, which the portal's own event
  labels spell out, so they are read one by one and before the milestone: `SOL_REI` and
  `SOL_REO` are returns to the sender, `SOL_RXI` sends the goods to a new address under a new
  reference (`in_transit`), and `SOL_ANN`, `SOL_MAR` and `SOL_MQD` cancel the shipment
  (`exception`).
- Scan stamps always carry an offset and are normalized to UTC. The local time helper stays
  because `explicitOffsetTime` in `core/time` preserves the source offset instead.
- `events[].location` is always empty: the only location-shaped fields (including
  `agency_location`) repeat the delivery address, not a depot. Parties, references,
  merchandise, pickup codes and appointment tokens are never retained; a test asserts it.

## Limitations

- No delivery estimate and no operational location.

## Testing

`npm run test:carriers:live -- carriers/heppner` (no env vars). It asserts a
synthetic, unassigned receipt number returns not-found.
