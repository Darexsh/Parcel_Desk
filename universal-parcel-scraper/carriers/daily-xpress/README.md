# Daily Xpress

Daily Xpress parcels use enabled universal providers. There is no dedicated adapter.

Daily Xpress is a domestic courier network headquartered in Chandigarh, India, run with
franchise partners.

## Numbers

A complaint gives an eight-digit air waybill. Eight digits are printed by many carriers, so
no rule claims them.

## Links

The home page form opens `searchAwb.php` with the number as `awb`.

## Why there is no adapter

`searchAwb.php` has no history of its own. Its script asks
`sdemo.in/daily/ppc/api4433/awbTrack.php?awb={number}` for a JSON list holding the
consignment and its scans, and draws the table from that. The service no longer exists: the
host answers HTTP 404 for that address, whatever the number, as it does for the pincode and
branch lists and the partner login beside it, so the page never shows a result. Daily Xpress
publishes no tracking app, so Daily Xpress stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
