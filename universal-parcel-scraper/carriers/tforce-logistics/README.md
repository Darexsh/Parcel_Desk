# TForce Logistics

TForce Logistics parcels use enabled universal providers. There is no dedicated adapter.

TForce Logistics is TFI International's final-mile network in the United States and Canada,
formerly Dynamex and then TForce Final Mile. It is separate from TForce Freight, TFI's
less-than-truckload carrier, which has its own entry.

## Numbers

The tracker takes an order number, reference or package ID. TForce's own labels carry `TF` and
twelve, thirteen or eighteen digits, which `tforce-logistics-1` claims; no other carrier's
numbers or rules use that shape. Most packages keep the retailer's own ID instead: twenty or
twelve digits, or letters naming the shipper such as `WCA`, `WM00AK` or `BBYC`. Archived
lookups on the tracker show both kinds, but the retailer IDs name the shipper rather than the
carrier, and the numeric ones share their shape with many carriers, so no rule claims them.

## Links

The tracking form on `tforcelogistics.com` opens
`direct.tfesg.com/finalmiletrack/Track?trackingNumber={number}&brand=0`. Archived lookups also
use `trackingNumber` on the tracker's older `track/externalTracking.jsp` page; the library reads
the number from either address.

## Why there is no adapter

The tracker answers a plain GET of that address with server-rendered HTML, with no token,
captcha or sign-in: the package's scans, each with its time-zone abbreviation, or TForce's own
"no shipments found" notice. Its firewall refuses whole countries, though: from Germany,
Switzerland, the Netherlands, Italy, Japan, Australia and Brazil, among others, Sucuri answers
HTTP 403 with its "Access from your Country was disabled" page, while the United States, Canada
and the United Kingdom get through. TForce's only app is an iPhone app for its operations and
business customers, so TForce Logistics stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
