# City Air Express

City Air Express parcels use enabled universal providers. There is no dedicated adapter yet.

City Air Express, which traded as CAE Delivers, carries next-day parcels from Great Britain to
Northern Ireland and Ireland. Its site is cityairexpress.com.

## Numbers

Waybills start with a depot code. An archived lookup on its own tracker reads `MN` and six
digits, and the tracker still answers it. Eight characters also fit other carriers' lettered
numbers, so `city-air-express-1` stays low confidence and no rule takes the other depot codes.

## Tracker

Its NetCourier tracker renders a waybill's events without a login or CAPTCHA; signatures need a
postcode. Each depot has its own host.

## Links

The trackers keep the waybill in the path.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
