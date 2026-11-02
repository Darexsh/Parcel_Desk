# XingYunYi

XingYunYi parcels use enabled universal providers. There is no dedicated adapter.

XingYunYi (行运易物流, XYY) is a Guangzhou forwarder backed by Cainiao, running small-parcel and
express lines from China to North America, Europe, Oceania and elsewhere. Its site is
xingyunyi.com.

## Numbers

Its site gives no number layout and no public page shows a XingYunYi number, so there is no rule.

## Why there is no adapter

The tracking page asks a JSON endpoint with a token shipped in the page, without a session or
CAPTCHA. It answers an unknown number with a placeholder order rather than an error, and no public
number is known to see a found reply.

## Links

The tracking page opens the number from its `nums` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
