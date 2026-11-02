# Kargoist

Kargoist parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Kargoist tracks parcels by the shop's barcode, so its numbers are digit runs of many lengths,
seen in complaints and an archived lookup. These stay unclaimed. Amazon parcels carry kar
followed by six or seven digits. Rule kargoist-1 suggests Kargoist for them with low
confidence, as Australia Post's ten-character consignment rule also matches the seven-digit
form.

## Links

The home page's search form opens getlink.php on kargoist.com with the number as `barcode`, and
older lookups used the kargotakip host with `har_kod`. Both are read as links. The tracking
pages ask for a code sent by SMS before showing a parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
