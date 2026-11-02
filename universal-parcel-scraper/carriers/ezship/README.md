# ezShip

ezShip parcels use enabled universal providers. There is no dedicated adapter.

ezShip (台灣便利配), run by 斗牛科技股份有限公司, is a Taiwanese convenience-store parcel service:
senders drop parcels at OK, Hi-Life or FamilyMart stores for collection at another store, and it
also delivers to homes. Its site is ezship.com.tw.

## Numbers

The sample receipts on its site show eight- and nine-digit store-to-store numbers, and the
tracker takes up to eleven characters. Both examples come from one image, and other carriers'
rules read eight and nine digits, so there is no rule.

## Why there is no adapter

Every lookup, by number or by the recipient's name and mobile number, needs an image CAPTCHA.

## Links

The tracker posts its form, so no address names one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
