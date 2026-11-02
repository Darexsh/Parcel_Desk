# Nhat Tin Logistics

Nhat Tin Logistics parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

The developer documentation's examples use CP followed by eight digits, and its webhook example
adds a final R. The low-confidence rule suggests Nhat Tin Logistics for that layout. With a
final 0 the shape also fits DHL eCommerce Spain's generic two-letter rule.

## Links

`ntlogistics.vn/tra-van-don.html?bill={number}` is the address the tracking page's own share
link builds.

## Why there is no adapter

The tracking page asks for reCAPTCHA before it searches, but its lookup,
`GET bwsv3.ntlogistics.vn/v1/website/search-from-es`, takes no token. That service refuses
connections from most networks outside Vietnam: from Europe, the Americas and most of Asia the
connection times out, while the website around it loads. The Nhat Tin Android app
(`vn.ntlogistics.app.user`) is a shipper app on the same network, and the developer API there
needs a partner's access token, so Nhat Tin Logistics stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
