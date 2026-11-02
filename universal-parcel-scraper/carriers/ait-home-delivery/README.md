# AIT Home Delivery

AIT Home Delivery parcels use enabled universal providers. There is no dedicated adapter yet.

AIT Home Delivery, formerly Panther Logistics, delivers bulky goods with two-person crews in the
United Kingdom, Germany and Austria. It belongs to the AIT group but runs its own network and
tracker, apart from [AIT Worldwide Logistics](../ait-worldwide/README.md), which keeps the bare
name AIT.

## Numbers

The tracker opens a delivery by a short key from the recipient's message. Retailers' AIT order
numbers do not open it, so no rule names either.

## Tracker

A JSON interface answers a key without a login or CAPTCHA, with separate hosts for the United
Kingdom and Germany. The key works like a capability, so no link rule takes it before an adapter
can keep it from universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
