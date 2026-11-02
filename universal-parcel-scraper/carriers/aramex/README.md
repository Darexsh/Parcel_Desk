# Aramex

Reads domestic and international shipment histories from the official tracking portal.
Detection offers an 11-digit number only when the first ten digits, divided by seven,
leave the last digit. Blue Dart waybills pass the same check, so the shape stays shared.

## How it works

An anonymous overview request returns a shipment card. Its matching number binds a signed
detail link, which is followed once on the same host. The detail page must independently
return the requested shipment number. No account, cookie bootstrap or browser is needed.
The portal may redirect that link once to a regional English tracking page; the signed
query must remain unchanged.

Global Shopper numbers can be submitted with an explicit Aramex selection. Their
numeric shape alone does not select Aramex automatically.

Requests use an application user agent because the edge rejects Node's default user
agent on server networks. The same header is sent on the overview, detail and regional
redirect requests.

## Notes

The parser reads the history rows and the shipment type, but no recipient details. It
reads the weight in kilograms, to the gram, only when the shipment has a single item.
From the progress rail it takes only a single destination country, kept by name when it
has no known code. Contact notes, payments, checks and network notices stage nothing,
so the status comes from the newest other row.
Cross-border dates have no offsets, so they remain local wall times. Invalid dates retain
their text, and incomplete scan rows fail the lookup. The app archives this
direct evidence and asks providers for a timestamped timeline before using it as a fallback.

## Limitations

The portal's local dates cannot establish freshness against another source. Signed links
are obtained anew for each lookup and are not stored in the result.

## Testing

`npm run test:carriers:live -- carriers/aramex`. Set
`ARAMEX_TRACKING_NUMBER` to check an authorized real shipment.
