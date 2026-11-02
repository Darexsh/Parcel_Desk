# Kuayue Express

Kuayue Express parcels use enabled universal providers. There is no dedicated adapter.

Kuayue Express (跨越速运, KYE) is a Chinese time-definite express carrier based in Shenzhen,
majority owned by JD Logistics. Its site is ky-express.com.

## Numbers

Its waybills read `KY` and thirteen digits, a layout its own tracker's validation lists and
public posts show. Older waybills of eleven or seven digits share their lengths with many carriers,
so they have no rule.

## Why there is no adapter

Each lookup on its tracker asks for a Tencent CAPTCHA or the last four digits of the sender's or
recipient's phone.

## Links

The tracker opens waybills from the `orders` parameter of its search page on www.ky-express.com
and of the frame it loads from u.ky-express.com, and its mobile route page from `waybillNo` in
its address's fragment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
