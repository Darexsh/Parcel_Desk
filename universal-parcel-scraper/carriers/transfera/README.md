# Transfera

Transfera parcels use enabled universal providers. There is no dedicated adapter.

Transfera d.o.o. Beograd is a Serbian forwarder and registered postal operator. It delivers parcels
from global online marketplaces such as Temu in Serbia and the rest of the Western Balkans,
alongside road, sea, rail and air freight, customs and warehousing, with sister companies in Bosnia
and Herzegovina and North Macedonia. Its site is transfera.com.

## Numbers

Its tracker takes five to twenty-four letters, digits, hyphens or underscores and gives no layout or
example. No public page shows a number, so there is no rule.

## Why there is no adapter

The tracker posts the number with an anti-forgery token and cookie from its page, without a login or
CAPTCHA, and answers an unknown number as not found. No public number has shown a known parcel's
reply yet. An adapter can follow.

## Links

Tracking links carry the number in the path after `/package/`, which fills in the tracker's form;
the reader still starts the search.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
