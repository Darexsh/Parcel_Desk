# Hapdong Express

Hapdong Express parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Hapdong Express prints bare digit waybill numbers; the sample on its own site has ten digits.
Its search field takes up to 21 characters without hyphens, and its lookup refuses numbers
older than four months. Many Korean carriers print the same digit runs, so no rule claims them.

## Links

The site looks numbers up from its home page through a script call that returns data, not a
page, so no address opens one parcel. The call is an anonymous GET to
`hdexp.co.kr/new/delivery_search_proc.do?barcode={number}` on the same platform and reply shape
as [Kyungdong Express](../kyoungdong/README.md). An unknown or expired number answers `fail`,
which the page words as a wrong number or a failed lookup, so it would not prove absence. No
found reply has been seen, so there is no adapter yet. The script still holds an older
`/delivery_search_proc.do` lookup that the search button no longer calls.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
