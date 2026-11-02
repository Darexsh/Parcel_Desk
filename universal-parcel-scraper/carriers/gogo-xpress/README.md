# GoGo Xpress

GoGo Xpress (QuadX) is a Philippine courier for online sellers. Its riders collect
parcels from merchants and its hubs deliver them across the country, handing some last legs
to a partner courier. Tracked through the lookup its tracker on `app.gogoxpress.com` makes.

## How it works

1. `direct`: one `GET https://api.gogoxpress.com/v1/track/{number}`, the request the tracker's
   `/track/{number}` page makes. It needs no cookie, token, key, phone digits or browser. The
   JSON reply has the shipment's status code and delivery estimate, and its scans grouped by
   phase, oldest first within each.
2. `retry`: the same read once more when GoGo Xpress cannot be reached.

- The lookup finds a number only as printed, in capitals with its hyphens, and only whole. The
  adapter accepts it typed either way and sends the printed form.
- A number the tracker does not know gets HTTP 400 with `Order Not Found`, which is not found.
  Another 400 is a changed reply. API Gateway's 403 `Missing Authentication Token`, a 404 or a
  redirect is a moved route; any other 403 is a block.
- The shipment must name the number asked.
- Recognition makes the same request.

## Notes

- Each scan's `status_updated_at` carries its offset, `+08`, so scans are instants. Its
  `created_at` is when GoGo Xpress recorded the scan, hours later for a partner's scans, and
  stands in only for a scan without the first.
- The scan's `status` code stages it and is its provider code. The description is the status
  name, then the remark when it adds something, such as
  `In transit: Via land: For transfer to delivery area : SAMPLE HUB`. The map also stages the
  codes the web app's own status filters group, which replies have not shown yet; another code
  falls to the shared rules on its name.
- The shipment's own code decides a delivery, a return, a cancellation, a failed pickup or a
  claim. The page hides claim and disposal scans and shows such a shipment as needing action,
  so the adapter skips those scans and reads the shipment as an exception.
- The page shows a scan's `masked_remarks` in place of its remark, and so does the adapter.
  Delivery and failed-delivery remarks name who took or refused the parcel, as a return's can,
  and a partner's relayed status (`POSTED STATUS : …`) is its staff's free text; without a
  masked remark the adapter keeps none of them. Other remarks lose who received or reported something,
  apart from a hub's own receipt, and phone numbers.
- A scan's location is the hub that made it, as the reply names it, in lower case. A partner's
  scans name none.
- The rider's name and phone, the item, the cash to collect, the proof-of-delivery photo and
  signature, the delay notice and the next pickup day are not kept, nor is the rider map the
  tracker opens at `/track/{number}/map`.

## Limitations

- No weight, service, sender or recipient. A partner that delivers the last leg is named only
  in a scan's wording, without its own number, so there is no hand-off.

## Numbers

GoGo Xpress tracking numbers have twelve letters and digits, printed in three groups of four
joined by hyphens; its help centre calls them twelve-character alphanumeric numbers. Older
lookups archived from its tracker have eight digits and four letters, newer ones mix letters
and digits in every group. Archived replies of its tracking API show such numbers with their
history.

`gogo-xpress-1` claims the hyphenated layout when it contains a letter. Typed without hyphens
the twelve characters fit Colis Privé's broad shape, so they stay unclaimed. All-digit groups
are left to the Japanese carriers that print them the same way, and the adapter does not send
them. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

GoGo Xpress's tracker opens one parcel at `app.gogoxpress.com/track/` followed by the number.
It looks the number up as it stands in the address, so it finds one only with its hyphens; the
library puts them back when a number is stored without them.

## Testing

`npm run test:carriers:live -- carriers/gogo-xpress`, with `GOGO_XPRESS_TRACKING_NUMBER` and
optionally `GOGO_XPRESS_UNKNOWN_NUMBER` set outside the repository.
