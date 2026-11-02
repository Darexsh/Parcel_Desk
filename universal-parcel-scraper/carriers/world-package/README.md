# World Package

World Package parcels use enabled universal providers. There is no dedicated adapter.

World Package (World Package Logistics Limited) is a British cross-border e-commerce carrier. It ships online
shops' parcels from the United Kingdom to the United States, Europe and Asia, wines and spirits among them, and
hands them to local couriers and posts for the last leg. Its site is worldpackage.co.uk.

## Numbers

Its tracker looks up World Package's own air waybill or job numbers. The last-mile carrier's number on a parcel
belongs to that carrier. No public page shows a World Package number, so there is no rule.

## Why there is no adapter

Its tracker runs on Courier Navigator, as [UBX UK's](../ubx-uk/README.md) and Hart2Hart Express's do, and reads
an open JSONP endpoint without a session or CAPTCHA, which answers an unknown number with an empty list. No
public number is known to see a found reply.

## Links

The tracking page opens numbers from its `consign_note` parameter, on its Courier Navigator host. The portal
page on worldpackage.co.uk frames the same tracker but does not load it, so links go to that host.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
