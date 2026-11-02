# PAXI

PAXI parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

PAXI's tracking page asks for the parcel number from the PAXI SMS, and its search field gives a
thirteen-digit example. No rule claims it: thirteen digits are a bare digit run many carriers
share.

## Links

The tracking page opens one parcel at `paxi.co.za/track-a-parcel?id={number}`, which embeds
PAXI's tracking app at `parcel-tracking.paxiplatform.com/?id={number}`. The page's search
buttons open the app's other host, `paxi-next-parcel-tracking.web.app/?ids={number}`. The
former page took the number as `drop_label` on `paxi.co.za/track`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
