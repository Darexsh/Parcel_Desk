# Linear Logistics

Linear Logistics delivers long items in the UK, including blinds and curtain poles. Its
native adapter reads the public tracker’s DX history without a session, postcode or browser.

## Retrieval

`direct` calls `https://linearlogistics.co.uk/tracking/lookup?q={number}`, the request built by
[the public tracking page](https://linearlogistics.co.uk/tracking). The former tracker at
`tracking.linearlogistics.co.uk` calls
`https://portal.linearlogistics.co.uk/api/v1/tracking/json?lpn={number}` and returns the same
history. The adapter uses the current site and retries once only after a network failure,
inside the caller’s remaining budget.

Every scan must name the whole requested `lpn` and the supported DX feed. The adapter
preserves the full timeline, including failed attempts and the booking of a later delivery.
A booking changes no stage. Scan clocks keep their local date and time because the tracker
states no offset. Receiver names, contacts and future delivery estimates are removed from
scan wording.

## Limitations

Only the DX references represented in the carrier’s number corpus are supported. The lookup
stays scoped to Linear’s endpoint; a DX-format number alone does not establish Linear
ownership. There is no detection rule or automatic recognition eligibility. Other carrier
feeds need separate validation.

The response has no event codes, parcel weight or proof of delivery. The adapter retains up
to 100 distinct scans and marks a longer history as truncated.

## Testing

Parser and HTTP tests use synthetic fixtures. Live inputs stay outside Git:

```sh
LINEAR_LOGISTICS_TRACKING_NUMBER=… LINEAR_LOGISTICS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/linear-logistics/adapter.live.test.ts
```
