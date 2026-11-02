# 360Lion

360Lion parcels use enabled universal providers. There is no dedicated adapter.

360Lion (纬狮物流), formerly Wish Global Logistics, is a Shenzhen operator of cross-border lines to
Latin America, delivering the last mile itself in Mexico. Its site is 360lion.com.

## Numbers

Archived lookups on its former tracker show WSH, a two-letter destination country, ten digits and
YQ, and a complaint about a SHEIN parcel that ProShips delivered in Colombia gives a number of the
same layout. The samples come from two sources, so the rule is low.

## Why there is no adapter

The tracking page asks an open JSON endpoint, `GET /prod-api/toms/crossSite/oms/hawbcode/v2?codes=`,
without a session or CAPTCHA, and files unknown numbers under a not-found group. No public number
is known to see a found reply.

## Links

The tracking page opens the number from its `trackNumber` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
