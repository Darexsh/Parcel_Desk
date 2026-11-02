# PAGO Logistics

PAGO Logistics parcels use enabled universal providers. There is no dedicated adapter.

PAGO Logistics (派格国际物流) is a Shenzhen forwarder shipping from China to the United States by air
and sea, with its own warehouses and last mile there. Its site is szpago.com.

## Numbers

Its site gives no number layout and no public page shows a PAGO number, so there is no rule.

## Why there is no adapter

The tracking form asks an open JSON endpoint without a session or CAPTCHA, and it limits how often
an address may ask. No public number is known to see a found reply.

## Links

The site opens the number from its `number` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
