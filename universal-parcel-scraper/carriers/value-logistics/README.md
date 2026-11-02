# Value Logistics

Value Logistics parcels use enabled universal providers. There is no dedicated adapter.

Value Logistics, the logistics business of Value Group (Pty) Ltd, founded in 1981 and based in
Elandsfontein, Gauteng, stores, distributes and delivers goods in South Africa, including online
orders and specialised home deliveries with final-mile crews. Value Express was its courier brand.
Its site is value.co.za.

## Numbers

Its tracker takes a waybill number or the sender's reference, which is often the shop's order
number, and gives no layout or example. No public number is known, so there is no rule.

## Why there is no adapter

The tracker is a plain page that reads the waybill from its address without a session or CAPTCHA,
and sends an unknown number back to its search form with a not-found message. Its freight system
also answers an open JSON service. No public number has shown a known shipment's reply yet. An
adapter can follow.

## Links

Tracking links carry the waybill number as `wb` on the tracker's `index.php` page. Links with `sr`
carry the sender's reference instead and are not read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
