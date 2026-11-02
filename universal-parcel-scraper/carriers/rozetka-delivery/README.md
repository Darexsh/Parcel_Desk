# ROZETKA Delivery

ROZETKA Delivery parcels use enabled universal providers. There is no dedicated adapter.

ROZETKA Delivery is the Ukrainian parcel service of the ROZETKA marketplace: senders hand parcels
in and recipients collect them at ROZETKA shops and pickup points. Its site is rozetka.delivery.

## Numbers

Its tracker takes twelve digits, or three letters, a dash and nine digits; it inserts the dash
only after `RMP`. Parcels the marketplace creates carry `RMP` numbers, and `rozetka-delivery-rmp`
suggests ROZETKA Delivery for them at low confidence, from two archived lookups on its own API.
Purolator's three-letters-and-nine-digits rule leaves `RMP` to it. The twelve-digit waybills
public pages show all start with `101`, but twelve digits is a length many carriers share, so
they have no rule.

## Why there is no adapter

Its tracker reads an open JSON API on rz-delivery.rozetka.ua without a session, for the last
status and for the whole history, and answered public numbers; an adapter is possible and not yet
written. The API wants `RMP` numbers with their dash.

## Links

The tracking page opens a number from its `parcel_id` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
