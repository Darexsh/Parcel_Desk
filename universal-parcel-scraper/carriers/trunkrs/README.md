# Trunkrs

Trunkrs parcels use enabled universal providers. There is no dedicated adapter.

Trunkrs delivers web shops' parcels the same or the next day in the Netherlands, Brussels and Flanders.

## Numbers

Trunkrs numbers have nine digits, those seen starting with 4. Trunkrs does not document the
layout, and nine digits are shared with TNT and other carriers, so no rule claims it.

## Links

Notifications link to `parcel.trunkrs.nl/{number}/{postcode}`. Only the number is read from
them; the postcode is not kept.

## Why there is no adapter

The tracker shows a shipment only with the recipient's postcode. Its service takes the number
and the postcode as HTTP Basic credentials and answers JSON, with no session or CAPTCHA, so an
adapter needs the postcode as a carrier input first. An unauthorized reply then means a wrong
number or postcode, not a missing parcel.

The notification address `parcel.trunkrs.nl/{number}/{postcode}` serves a page that embeds the
shipment as JSON: its current state with a code such as `SHIPMENT_DELIVERED`, delivery
attempts, internal sorting notes and the delivery window, next to the recipient's name and
address, which an adapter must not keep. A wrong pair redirects.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
