# ProMed Delivery

ProMed Delivery parcels use enabled universal providers. There is no dedicated adapter.

ProMed Delivery (Pro-Med Delivery Inc) is a Shelby Township courier making same-day and next-day deliveries
for businesses, healthcare among them, across Michigan. Its site, promeddelivery.com, answers only over plain
HTTP; its tracker is an e-Courier tenant, promeddel.e-courier.com.

## Numbers

Its tracker looks up e-Courier order numbers, plain digits of no published length. No public page shows a
ProMed Delivery number, and plain digits are shared by other carriers, so there is no rule.

## Why there is no adapter

Its tracker is an HTML page without a login or CAPTCHA. It searches order references as well as order
numbers, so a short or shared value lists other customers' orders: an adapter would have to send the exact
order number and refuse such a list. No public number is known to see a found reply.

## Links

The site's tracking form opens the e-Courier tracker with the number in its address, but that tracker
matches references too, so such a link could open other customers' orders. The library neither reads
these links nor builds one.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
