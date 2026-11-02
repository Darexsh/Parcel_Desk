# Blue Streak Couriers

Blue Streak Couriers parcels use enabled universal providers. There is no dedicated adapter.

Blue Streak Couriers, founded in Jacksonville, Florida, in 1984, is a regional carrier in the
southeastern United States with branches in Florida, Georgia, South Carolina and North Carolina. It
carries parcels and less-than-truckload freight the same day, the next day or on a schedule, and
makes white-glove deliveries. Its site is bluestreakcouriers.com.

## Numbers

Its client portal's Quick Track finds an order by its tracking id, digits, a dot and six digits, or
by the customer's own references. No public id is known, so there is no rule.

## Why there is no adapter

Every Quick Track lookup needs the key printed with the order as well as its id, and the replies
carry pickup and delivery addresses and contacts.

## Links

Quick Track links carry the order's key, which works as an access token, so no link rule reads them.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
