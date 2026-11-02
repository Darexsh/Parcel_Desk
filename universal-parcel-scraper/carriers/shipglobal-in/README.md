# ShipGlobal India

Tracks ShipGlobal India's cross-border parcels through its anonymous guest API, including domestic,
flight and delivery-partner history.

## How it works

1. `direct`: reads `https://tracking.shipglobal.in/api/tracking?trackingId=` for the whole number,
   as the [official page](https://shipglobal.in/tracking/)'s
   [request builder](https://shipglobal.in/wp-content/uploads/tracking/index.js) does. No account,
   session or CAPTCHA is needed. A shipment must return the exact number and dated activity.
2. `retry`: repeats a read only after a network failure, within the same budget.

The older `https://app.shipglobal.in/api/tracking/` guest GET returns the same combined history;
the page also retains an older POST builder that attaches a CAPTCHA token. The adapter uses
the current builder's endpoint.

## Notes

Scan clocks without an offset remain local, including minute-only flight scans. Foreign partner
legs cannot inherit India's zone. An offset the service states is preserved.

A generic delivery after return-to-sender activity completes the return. Placeholder zero codes
are ignored because unrelated sources share them. Names, postcodes, account data, signatures,
contacts and handoff URLs are discarded. Ambiguous partner labels do not assign a delivery carrier.

## Limitations

Undated rows are retained alongside dated history and mark the answer incomplete, leaving enabled
universal providers eligible to supply richer history. Replies without dated activity do not confirm
a shipment. Oversized histories are rejected, and a retained event limit marks the answer incomplete.

## Testing

`SHIPGLOBAL_IN_TRACKING_NUMBER` enables positive live checks; `SHIPGLOBAL_IN_UNKNOWN_NUMBER`
enables the explicit not-found check. Inputs stay in the caller's environment.

`npm run test:carriers:live -- carriers/shipglobal-in`
