# QLS

QLS parcels use enabled universal providers. There is no dedicated adapter.

QLS (Quince Logistics Services) is the logistics arm of Quince, the San Francisco retailer, now
shipping other brands' parcels from Asia to the United States under one number from origin to
the door. Its site is qls.quince.com.

## Numbers

No public page shows a QLS number, so there is no rule.

## Why there is no adapter

Each number has its own server-rendered page, without a session or CAPTCHA, and an unknown
number gets "Order not found". No public number is known to see a found reply.

## Links

Tracking pages are `/<brand>/track/<number>` on qls.quince.com, QLS's own under `qls` and each
client brand's under its name, so the number is read from any of them.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
