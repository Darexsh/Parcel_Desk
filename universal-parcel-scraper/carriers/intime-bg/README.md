# In Time Bulgaria

In Time Bulgaria parcels use enabled universal providers. There is no dedicated adapter yet.

In Time is a Bulgarian courier on the market since 1990 and UPS's contractor in Bulgaria. Its
site is intime.bg. It is not the Czech IN TIME, now [One by Allegro CZ](../wedo/README.md).

## Numbers

Its shipment numbers are nine digits, a length many carriers share, and UPS parcels it delivers
keep their 1Z number, so no rule names it. The only public numbers are on share pages keyed by
a private token.

## Tracker

The tracking page embeds a courier app that answers one form post per number, without a
session or CAPTCHA, with the latest status only. An unknown number gets an empty table.

## Links

The tracking page opens a number from its `track_number` parameter, and the courier app from
its `/tracking/code/` path.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
