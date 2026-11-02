# XD Express

XD Express parcels use enabled universal providers. There is no dedicated adapter.

XD Express (迅达速递), run by Global Trades Melbourne Pty Ltd, is a Melbourne parcel line to China for milk
powder, health products, small appliances and food, cleared through customs with partners including EMS.
Its sister brand 迅雷速递 shares its tracker. Its site is xdexpress.com.au.

## Numbers

Its tracker asks for a waybill number and gives no layout. Tracking directories show `XD`, eight digits and
`AU`, but no public page shows an XD Express number, so there is no rule.

## Why there is no adapter

Its tracker is an ASP.NET WebForms page without a login or CAPTCHA: a lookup posts the page's view state
back to `Express.aspx` on www.xdexpress.com.au with the numbers, separated by spaces or commas, in `txtNo`,
and gets the result as HTML. An unknown number reads 没有跟踪信息 ("no tracking information") with HTTP 200.
No public number is known to see a found reply.

## Links

Its tracker looks numbers up by posting its form back, so no address names one.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
