# Direct Freight Express

Direct Freight Express parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Consignment numbers on Direct Freight Express's tracker and in reviews are thirteen digits.
Many carriers print thirteen-digit numbers and nothing in these points to this network, so no
rule claims them.

## Links

The consignment status page reads a number from `consignment_no` with `lookuptype=0`, as
archived lookups on the carrier's site show.

## Why there is no adapter

The consignment status page renders a consignment's scans in its own HTML, with no key or
sign-in. Cloudflare answers it, and the tracking form's post, with an HTTP 403 challenge page
before any result; a browser passes the challenge on its own. Direct Freight's dispatch API
tracks consignments only with an account's API key and number, and Direct Freight publishes no
tracking app, so Direct Freight Express stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
