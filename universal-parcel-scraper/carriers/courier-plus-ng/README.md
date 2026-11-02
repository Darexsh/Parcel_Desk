# CourierPlus

CourierPlus parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

CourierPlus is a Nigerian courier and logistics company. Its waybills seen on its own tracker
address are a digit, a letter and eleven digits. No rule claims them: the shape is also La
Poste's two-character layout, and nothing in the number names CourierPlus.

## Links

The public tracker on selfservice.courierplus-ng.com looks parcels up through a request the
page sends, so no address opens one parcel there. The older tracker on
trackplus.courierplus-ng.com took the number in its `query` parameter, and those addresses are
read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
