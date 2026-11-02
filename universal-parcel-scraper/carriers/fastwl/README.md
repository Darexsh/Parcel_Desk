# Fast World Logistic

Fast World Logistic parcels use enabled universal providers. There is no dedicated adapter.

Fast World Logistic (FastWL) is a French cross-border e-commerce carrier with sorting centres in
France and warehouses elsewhere in Europe and in the United States. Its site is fastwl.com.

## Numbers

Its site gives no number layout and no public page shows a Fast World Logistic number, so there is
no rule.

## Why there is no adapter

The tracking page looks the number up from its `trackingNumber` parameter and answers with HTML,
without a session or CAPTCHA. It answers a malformed number and an unknown one with the same
notice that the number is not valid, and no public number is known to see a found reply. Its
tracking API needs a customer account.

## Links

The French tracking page opens the number from its `trackingNumber` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
