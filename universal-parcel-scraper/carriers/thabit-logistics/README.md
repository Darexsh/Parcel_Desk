# Thabit Logistics

Thabit Logistics parcels use enabled universal providers. There is no dedicated adapter.

Thabit Logistics (ثابت), the Al Thabit Mail Transport Company, is a Riyadh last-mile and e-commerce courier, a
licensed postal service provider delivering online shops' parcels across Saudi Arabia with payment on
delivery. Its site is thabit-logistics.com.

## Numbers

Its tracker takes an air waybill number as free text. No public page shows one or its layout, so there is no
rule.

## Why there is no adapter

Its tracker is an open HTML page without a session or CAPTCHA:
`GET thabit-logistics.com/track-shipment/{number}`. It shows the number's result table, and for an unknown
number HTTP 200 with a "Record Not Found" heading in that table. An adapter should read that heading as a
missing parcel only on a page that carries the tracker form, as a blocked page is not a miss. No public number
is known to see a found reply.

## Links

The tracker opens a number from its path, `/track-shipment/<number>`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
