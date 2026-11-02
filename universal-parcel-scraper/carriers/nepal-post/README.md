# Nepal Post

Tracks Nepal Post's internal postal history through its anonymous, server-rendered tracker.

## Retrieval

One `direct` GET opens `pits.gpo.gov.np/Inquiry/InquiryIndexClient?ItemId={number}`.
Both the form's item and the event-table heading must match the whole requested identifier.
Only the matching page's explicit "No Events Found" answer establishes absence. Block pages,
unavailable endpoints and changed tables retain their failure kinds.

The internal system records Nepal's local scan clocks. Each clock keeps its wall time and a
deduced Kathmandu instant with its carrier basis. The adapter reads the operation and office;
operator logins, monetary amounts and free-form condition fields are excluded. Enabled
providers can supplement the international legs this internal history does not cover.

## Network access

The tracking host requires Nepali egress. Consumers outside Nepal supply an appropriately
routed `fetcher` through the adapter environment; proxy credentials stay with the consumer.
No account, token, browser or CAPTCHA is needed.

## Numbers

The adapter accepts postal S10 items. An `NP` issuer proposes Nepal Post for HTTP recognition;
only a matching history confirms that it knows the item. No separate domestic layout is claimed.

## Links

The General Post Office in Kathmandu links two trackers. For international tracking it links the
UPU's Global Track & Trace, which the [UPU provider](../../providers/upu/README.md) reads. For
domestic tracking it links Nepal Post's internal tracking system, which opens one item at
`pits.gpo.gov.np/Inquiry/InquiryIndexClient?ItemId={number}`, also served from the address
`202.166.194.38`. The library reads the number from both.

## Testing

Set `NEPAL_POST_TRACKING_NUMBER`, optionally `NEPAL_POST_UNKNOWN_NUMBER`, and
`NEPAL_POST_PROXY_URL` outside Git, then run:

```sh
npm run test:carriers:live -- carriers/nepal-post
```
