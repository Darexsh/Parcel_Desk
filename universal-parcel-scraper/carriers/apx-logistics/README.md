# APX Logistics

APX Logistics parcels use enabled universal providers. There is no dedicated adapter.

APX Logistics is the trade name of Asian Pacific Express, a Karachi international courier and cargo company
with an office in the United Arab Emirates. Its domestic arm, APX International, delivers within Pakistan. Its
sites are apxlog.com and apxintl.com.pk.

## Numbers

Neither site gives a layout for its consignment numbers, and no public page shows one, so there is no rule. It
sends some international parcels through DHL, FedEx or TNT, which carry them under their own numbers.

## Why there is no adapter

Its international tracker is an open server-rendered page without a session or CAPTCHA:
`GET corporate.apxlog.com/trc/tracking.php?id={number}`. An unknown number gets HTTP 200 with "No Data Found.".
The domestic tracker is a form posted to `www.apxintl.com.pk/track.php` with `airway_bill_number` and an empty
`submit` field, without which the form only comes back; an unknown number gets HTTP 200 with a message that the
airway bill does not exist. No public number is known to see a found reply on either.

## Links

The international tracker opens numbers from its `id` parameter, on corporate.apxlog.com and apxlog.com. The
domestic tracker has no address for a single number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
