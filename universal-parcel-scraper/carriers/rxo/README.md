# RXO

RXO parcels use enabled universal providers. There is no dedicated adapter yet.

RXO took XPO's last-mile business when it was spun off in 2022. It delivers big and bulky items
such as appliances and furniture to homes for retailers in the United States and Canada. It is
not [XPO](../xpo-ltl/README.md), which kept XPO's freight business.

## Numbers

No public page shows an RXO tracking number, and the tracker's hint is a template, so no rule
names it. Retailers' order numbers also open the tracker.

## Tracker

The tracker asks a JSON interface without a session, key or CAPTCHA, by tracking number or by
retailer reference.

## Links

The tracker opens a number from its `trackingnumber` parameter. XPO's former tracker took the
same parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
