# Pannon XP

Pannon XP parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Pannon XP is a Hungarian domestic express courier whose system is called PXP Futár. Its
shipment number has 24 digits and starts with 35814, followed by a seven-digit waybill number,
three zeros, a two-digit parcel index, 36 and the recipient's postcode padded to five digits.
Labels print it in groups separated by spaces. Pannon XP's own API documentation gives examples
of it, the tracker's script checks for it, and the site's contact form tells customers that
Pannon XP numbers start with 35814. `pannon-xp-1` claims it with high confidence; InPost,
bpost, Ciblex and Austrian Post accept any 24 digits with low confidence only.

The tracker also finds a parcel by its seven-digit waybill number alone, or by the six digits
printed on a manual waybill. These short digit runs stay unclaimed.

## Links

The tracking page posts the number to a script, so no address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
