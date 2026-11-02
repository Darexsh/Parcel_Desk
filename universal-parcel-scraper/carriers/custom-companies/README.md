# The Custom Companies

The Custom Companies parcels use enabled universal providers. There is no dedicated adapter.

The Custom Companies is a less-than-truckload and truckload carrier based in Chicago and Los
Angeles. Its tracking box on the home page opens a shipment details page with the status, the
delivery details and the scan history.

## Numbers

Archived lookups on the carrier's shipment details page show eight-digit shipment numbers. Some
histories name interline partners for the final leg. Bare eight-digit runs are other carriers'
numbers too, so no rule claims them and a gap declaration covers the layout.

## Links

`api.customco.com/shipmenttrace.htm?referencenumber={number}` opens one shipment: the home
page's tracking script builds it. Archived lookups on
`api.customco.com/scripts/cgiip.exe/boldetail.htm` carry the shipment number in `wpro1`.

## Why there is no adapter

The home page's tracking script opens that shipment details page directly, with no token,
captcha or sign-in. Its host, `api.customco.com`, which also serves the customer sign-in,
does not answer connections from Europe, though: the connection times out before any reply,
for the whole host, while `www.customco.com` answers. The Custom Companies publishes no
tracking app, so it stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
