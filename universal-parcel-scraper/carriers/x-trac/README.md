# X-TRAC

X-TRAC parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

X-TRAC is a logistics company near Chicago that tracks e-commerce parcels in the United States.
Its public API documentation gives a tracking number made of EXTRA and eleven digits as its
example.

`x-trac-1` claims EXTRA and eleven digits with high confidence because no other carrier uses
that prefix.

## Links

The tracking page has no address for one parcel. It reads no query parameter and looks numbers
up through a JSON API, so the catalog has no tracking URL template and no link rule.

## Why there is no adapter

The page's script reads `GET /api/public/tracking/query?trackNumbers=` on xtrac-express.com,
with up to a thousand numbers separated by commas, and needs no key. An unknown number and the
API documentation's example both get a success code with an empty `data` list. No public page
shows a current number, so a found reply has not been seen.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
