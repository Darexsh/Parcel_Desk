# APG eCommerce Solutions

APG eCommerce Solutions parcels use enabled universal providers. There is no dedicated adapter.

APG eCommerce Solutions, formerly Aramex Global Solutions, is Australia Post's cross-border
e-commerce consolidator. It carries retailers' parcels from the UK, Europe, China, the US and
Australia and hands them to a destination carrier such as Australia Post, NZ Post or USPS. Its
site is apgecommerce.com.

## Numbers

Its tracker takes APG's own references, retailers' order numbers and the destination carrier's
number. Its references are plain digits of lengths many carriers share, so there is no rule.

## Why there is no adapter

Its result page renders a shipment's history as HTML from a GET without a session, and answers
an unknown reference with HTTP 200 and an "order not found" message. No current public reference
is known to build a fixture from.

## Links

The result page opens a reference from its `track_sequenceNo` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
