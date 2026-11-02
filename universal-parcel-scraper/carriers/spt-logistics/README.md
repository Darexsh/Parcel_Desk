# SPT Furniture Logistics

SPT Furniture Logistics parcels use enabled universal providers. There is no dedicated adapter.

SPT Furniture Logistics is a furniture and bulky-goods carrier from Tabor Wielki near Kępno, Poland. It delivers
online shops' and manufacturers' orders across Poland and to Germany, Austria, Czechia, Slovakia, the
Netherlands and Belgium, with carry-in and assembly. Its site is spt-logistics.eu. SPT Express, the Chinese
forwarder universal providers name SPT, is a separate entry.

## Numbers

Its trackers ask for a tracking token that its order panel issues for each order, in a layout no page
describes. No public page shows one, so there is no rule.

## Why there is no adapter

Its two trackers are server-rendered pages without a session or CAPTCHA: `GET spt-s.pl/status/index.html?key=`
for Poland, and the same path on spt-de.eu for the rest of Europe. They keep separate records, so an adapter
would ask both. An unknown token gets HTTP 200 with an invalid-token message. No public token is known to see a
found reply.

## Links

Both trackers open a token from their `key` parameter. No portal link is published, since one host would miss
the other's parcels; the catalog sends people to the site's tracking form, which picks the tracker.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
