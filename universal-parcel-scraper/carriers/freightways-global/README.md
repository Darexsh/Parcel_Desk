# Freightways Global

Freightways Global parcels use enabled universal providers. There is no dedicated adapter.

Freightways Global, formerly First Global, is the Freightways group's international parcel and freight business
in New Zealand. It clears online shops' imports through its bonded facilities in Auckland, Christchurch and
Wellington and hands them to the group's couriers, NZ Couriers for most, for the last mile; it also ships
exports. Its site is freightwaysglobal.co.nz and its tracker track.fgmailconnect.co.nz. It is not an alias of
[NZ Couriers](../nz-couriers/README.md): its tracker finds its imports by their bare label number and carries
their customs scans, while the NZ Couriers adapter refuses their layout, three letters and nine digits.

## Numbers

Its imports carry `NZC` and nine digits, labels printed on its own NZ Couriers account. Every public
example is an archived lookup on its tracker under one shipper's account, and [DAI
Post](../dai-post/README.md)'s tracker answers the newest with its own history, so `dai-post-1`
names DAI Post for that layout and this entry has no rule. Every consignment also carries a `GSS`
number from GoSweetSpot, the shipping platform the tracker runs on, which other shippers'
consignments share, so no rule takes it. Its older exports to Australia carried other layouts the
tracker no longer knows.

## Why there is no adapter

Its tracker is an open HTML page on GoSweetSpot's white-label platform, without a session or CAPTCHA:
`GET track.fgmailconnect.co.nz/?id={number}`, or the number in the path. A found consignment shows its stages
and scans with the carrier that made each, on New Zealand clocks without an offset, and its label, GSS and
account-prefixed numbers. An unknown number gets HTTP 200 with "No results found" on a page like the empty
search page, so an adapter has to read the text. It keeps consignments for under a year. No adapter has been
written for it yet.

## Links

The tracker opens numbers from its `id` parameter or from its path, where archived links put an account number
and a hyphen before the label.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
