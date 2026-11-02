# APC Overnight

Tracks APC Overnight consignments, the UK next-day network of independent depots, through APC
Choice's public tracking page.

## How it works

Merchants link their customers to `https://apcchoice.apc-overnight.com/track-parcel?id=<waybill>`,
which renders the consignment on the server. The adapter reads that page with one GET. No
account, cookie, key, postcode, CAPTCHA or browser is needed. A request that fails to reach APC
is sent once more within the budget.

The search on `apc.co.uk` and the APC Choice login ask for the recipient's postcode with the
number. On the tracking page the postcode only opens proof of delivery and the recipient's
delivery options, which the adapter does not read, so no postcode is asked for.

The page names the consignment by its seven-digit number, the end of the waybill. The tracker
looks up only the whole waybill, so the page is bound to the requested one by those seven digits.
A waybill it does not have comes back on the search page with "Your consignment could not be
found", which is a missing consignment only when the search field holds the requested waybill.
"Consignment identifier is invalid" is a number the tracker does not accept. Redirects, other
notices, block pages and HTTP errors keep their own failure kinds. Recognition uses the same
lookup.

## Numbers

An APC waybill has twenty-two digits: the booking date as `20YYMMDD`, then digits that end with
the seven-digit consignment number. The adapter takes only that shape with a real date; anything
else is invalid without a request. Other carriers' numbers share the shape, so detection only
suggests APC Overnight for it, and preflight asks APC first.

## Notes

Each item of a consignment has its own journey through the network, and every item repeats the
consignment's delivery records. The adapter merges them by clock and keeps a row once when items
share it. Only the first line of a delivery record is read. "Delivery Rearranged By Customer" is
a delivery moved by the recipient, not a movement, so the consignment keeps the stage it had. A
delivery after a return to sender is the return reaching the sender. Wording the map does not
know goes to the shared wording rules.

Rows carry the depot's wall clock without an offset and are kept as local times. The rows carry
no place. The weight and the service name come from the consignment summary. The delivering
depot's contact details, the sender's reference and the item count are not read.

## Limitations

The tracker takes the seven-digit consignment number alone only with a postcode, so it is not
tracked. Older consignments keep their delivery records but no longer their journeys. Proof of
delivery and delivery time slots stay behind the postcode. The page has no estimated delivery
date.

## Links

The link opens APC Choice's tracking page for the waybill.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Recognition stays on direct HTTP. Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.

## Live test

Set `APC_OVERNIGHT_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/apc-overnight/adapter.live.test.ts`.
Optionally set `APC_OVERNIGHT_UNKNOWN_NUMBER` to check a waybill APC does not have.
