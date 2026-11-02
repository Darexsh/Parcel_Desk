# Flyking Courier Services

Flyking Courier Services parcels use enabled universal providers. There is no dedicated
adapter.

Flyking Courier Services is a domestic courier network based in Mumbai, India.

## Numbers

The tracker takes C'Note numbers. Complaints give eight-digit numbers up to 2015 and nine-digit
numbers from 2014 on. Digit runs of these lengths are printed by many other carriers, so no
rule claims them.

## Links

The tracker posts its form back to the same page and ignores numbers in its address, so no
address opens one parcel.

## Why there is no adapter

The tracker is an ASP.NET page whose form posts the number back with the page's view state;
archived copies of the page show no captcha or sign-in in front of it. Its host does not
answer connections from Europe: the connection times out, as it does for the customer and
member login portals on the same host. Flyking has no app on Google Play, so Flyking Courier
Services stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
