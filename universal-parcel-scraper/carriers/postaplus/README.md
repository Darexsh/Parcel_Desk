# PostaPlus

PostaPlus parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

PostaPlus air waybills are twelve digits. Detection does not claim them, because many carriers
print bare twelve-digit numbers.

## Links

The home page's tracking form opens one waybill from `?trackid={number}&trackby=awb`. Older
links use `sno` on `Customer/ShipmentDetails.aspx`; the library reads both.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
