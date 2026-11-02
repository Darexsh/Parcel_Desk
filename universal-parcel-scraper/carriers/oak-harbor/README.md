# Oak Harbor Freight Lines

Oak Harbor Freight Lines is a less-than-truckload freight carrier in the western United States.
Partner carriers hand it freight bound for its network. Tracked by PRO through the action its
tracing page calls.

## How it works

1. `direct`: one `POST https://www.oakh.com/tracingactions.php` with the form the tracing page at
   `www.oakh.com/page/tracing` sends for a PRO: `action=loadTraceDetails`, the whole PRO in
   `traceNum` and `tracePro`, `traceType=OHPRO`, `showPrevious` and `showNext` false and
   `traceAccount=0` for a guest. It needs no cookie, token or browser; the adapter sends the
   page's `Referer` and `X-Requested-With` as its script does. The reply is an HTML fragment: the
   number looked up in hidden fields, then a notice or the shipment's information and its trace
   history, newest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- The hidden fields must hold the PRO asked, and the shipment's `OAKH Pro:` must be that PRO:
  the tracker also finds shipments by other references, and one found that way is
  inconclusive.
- "Pro Not Found" is the only missing shipment. The tracker answers an unknown PRO, and one it
  cannot show, with "There was an issue tracking your shipment. Please reach out to customer
  support.", so that notice is inconclusive. An empty reply, a redirect, a 404 and a block page
  keep their own failure kinds.
- The tracing page loads Cloudflare's Turnstile script but shows no check, and its lookups send
  no token.
- The adapter asks by whole PRO (`OHPRO`) only; the page's searches by bill of lading, partner
  PRO, purchase order, shipper's number and pickup number are not used.

## Notes

- Each history row has a date, a 24-hour time, the action and a place. Clocks carry no zone and
  stay local times.
- A terminal's place is its town, followed by its phone number, with its address in a tooltip.
  Neither is read. A delivery row's place is the consignee's town, as the page shows it.
- A delivery row ends with the signer's name ("Delivered Signature-…"); the name is dropped and
  the row reads "Delivered". An appointment row keeps its day and window after "Appointment-".
- The delivery status settles a delivery, a return or a problem, and a shipment without a staged
  row. Otherwise the newest staged row is ahead of it. Repeated rows appear once.
- The estimate is the shipment's `Estimated Delivery:` day, dropped once the freight is
  delivered.
- The information block names the shipper and consignee with their towns and ZIP codes, and
  holds the bill of lading, the shipper's number and the purchase order. None of them is read.
  The form to email delivery receipts and bills of lading is not used.

## Limitations

- No service, sender, recipient, signature, weight or delivery receipt, and scans have no
  offset.
- An unknown PRO ends inconclusive, so no recognition is declared.
- A PRO reaches the adapter when it is filed under Oak Harbor or opened from an Oak Harbor link:
  eight digits are shared by many carriers, so no rule claims them and preflight does not ask it.
- Oak Harbor's web services list a SOAP `getShipmentInfo` operation at `www.oakh.com/services/soap/`
  that answers an unknown PRO with a fault saying it is invalid or could not be found. The site
  describes those services as business integrations set up with a web services account, so the
  adapter does not use them.

## Numbers

Oak Harbor tracks less-than-truckload freight by its PRO, eight digits without a check digit; its
forms take eight digits. Lookups archived from its own quick trace page show PROs starting with
1, 2, 80 and 81, and its home page gives one starting with 3. The adapter takes eight digits that
do not start with 0, since the tracker reads a PRO as a number. The samples and their sources are
in [`numbers.json`](numbers.json).

## Links

The home page's trace form opens one shipment at `www.oakh.com/quicktrace&PRO={number}`, with the
number inside the path rather than in a query string. The library reads the number from that
address in either case.

## Testing

`npm run test:carriers:live -- carriers/oak-harbor`, with `OAK_HARBOR_TRACKING_NUMBER` and
optionally `OAK_HARBOR_UNKNOWN_NUMBER` set outside the repository.
