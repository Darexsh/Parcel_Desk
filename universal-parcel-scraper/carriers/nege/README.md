# SST Express

SST Express parcels use enabled universal providers. There is no dedicated adapter.

SST Express (Skubių siuntų tarnyba) is the brand of UAB Nėgė, a Kaunas courier delivering next-day parcels and
pallets across Lithuania from its regional terminals, with road freight to Latvia, Estonia and Poland. Its site
is sst.lt; the older nege.lt still runs.

## Numbers

Its tracking number is the waybill number, and the older tracker takes seven or ten characters. No public page
shows one, and short runs of digits are shared by other carriers, so there is no rule.

## Why there is no adapter

Its tracking page reads an open JSON endpoint without a session or CAPTCHA:
`GET sst.lt/api/tracking?number={number}`. It answers an unknown number with HTTP 404 and an error in the body.
Its `overhead` flag turns true once a client has used up its hourly quota of lookups, which is a rate limit, not a
missing parcel. The page shows a found parcel as milestones, from pickup through the regional and central
warehouses to delivery. The older nege.lt's `shipments.php?number=` reads the same records and answers an
unknown number with HTTP 200 and no `number` key. No public number is known to see a found reply.

## Links

The tracking page opens a number from its path, `/sekti/<number>`, also under `/en/`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
