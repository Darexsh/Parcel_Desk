# AllJoy

AllJoy parcels use enabled universal providers. There is no dedicated adapter.

AllJoy (全和悦) is a Shenzhen supply-chain firm running e-commerce parcel lines from China to Turkey,
South Asia and the Middle East. Its tracking portal is web.alljoylogistics.com.

## Numbers

`alljoy-1` suggests `ALJTR`, a six-digit date and seven digits, the Turkey line's numbers, and
`alljoy-2` suggests `ALJ`, two letters, ten digits and `YQ`, both at low confidence. The public
examples are archived lookups on its former tracker; its current system may number parcels
differently.

## Why there is no adapter

Its tracking portal posts numbers to a JSON API without a session, and the API answers an unknown
number with an explicit not-found. No current public number is known to confirm a found reply.

## Links

The tracking portal opens a number from its `order` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
