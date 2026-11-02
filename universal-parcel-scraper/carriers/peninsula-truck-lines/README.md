# Peninsula Truck Lines

Peninsula Truck Lines parcels use enabled universal providers. There is no dedicated adapter.

Peninsula Truck Lines is a less-than-truckload carrier in Washington, Oregon, Idaho and British
Columbia, based in Federal Way. Its site is peninsulatruck.com.

## Numbers

Its PRO numbers have no published layout, and no public one has been found, so there is no rule.

## Why there is no adapter

Its tracker reads an open JSON lookup without a key, but no public PRO number has been found to
check a found reply with. The site itself refuses visitors outside North America.

The public client uses `ptlprodapi.azurewebsites.net` and the anonymous
`/track/public/{pro}` route. Its signed-in `/track/{pro}` route is separate and is not needed
for guest tracking. US egress can open the site; a matching found response is still needed
before adding a direct adapter.

## Links

The tracking page opens a PRO number from its `pro_number` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
