# ARK Express

ARK Express parcels use enabled universal providers. There is no dedicated adapter.

ARK Express (方舟速递), run by ARK International Express Pty Ltd, is a Melbourne parcel line. It flies parcels from
Australia to China, clears them through customs there and hands them to China Post or EMS for delivery, and also
ships to Malaysia. It has processing centres in Melbourne, Sydney and Brisbane. Its site is arkexpress.com.au.

## Numbers

Its tracker takes ARK Express's own waybill numbers. The one public example with scans, a lookup on its own
tracker that a search engine indexed, is `AP`, seven digits and `AU`; `ark-express-1` suggests that layout at
low confidence, as it is the only example. Another indexed lookup carries `ARK`, eight digits and `AU`, but the
tracker said no such order exists, so it is kept as quarantined evidence and no rule takes that shape. Neither
layout is an S10 number. The China Post or EMS number a parcel gets for its last leg belongs to that post.

## Why there is no adapter

Its tracker is an open HTML page without a session or CAPTCHA:
`GET www.arkexpress.com.au/searchOrder?orderNo={number}`, over plain HTTP, as the site's HTTPS certificate has
expired. It answers an unknown number with HTTP 200 and a message that the order does not exist or the system is
busy, so a missing parcel cannot be told apart from a failure. The page also carries an invoice that its script
shows once the visitor types the recipient's first initial; an adapter must leave it out. A second tracker,
`GET express.arkexpress.com.au/q?s={number}`, answers over HTTPS and says when it finds nothing. Neither finds
the public example any more.

## Links

The trackers open numbers from the `orderNo` parameter of `/searchOrder`, on www.arkexpress.com.au and its
`mel` and `en` subdomains, and from the `s` parameter of `/q` on express.arkexpress.com.au. The portal link goes
to express.arkexpress.com.au, which answers over HTTPS.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
