# Line Clear Express

Line Clear Express is a Malaysian courier with its own branch and hub network. Tracked through
the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://lineclearexpressonline.com/ce/1.0/viewandtrack` with the body
   `{"SearchType":"WayBillNumber","WayBillNumber":["{number}"]}` and the bearer token the
   tracking page's script sends for every visitor. It needs no cookie, session or browser. The
   JSON reply has one list of scans per number searched, roughly newest first. A second
   `GET https://lineclearexpress.com/my/api/branchplace?search={codes}` gives the places of the
   branch codes the scans name, as the page asks for them.
2. `retry`: the same reads once more after a network failure or a hang.

- An unknown number is HTTP 200 with a message that the waybill is invalid or does not exist,
  which the page reports as not found. A 404 or a redirect is a moved route.
- A refused token is HTTP 500 with `Authorization failed`, reported as a challenge. Another 500
  is inconclusive.
- Every scan must name the waybill asked.
- Recognition makes the first request only, without the branch places.

## Notes

- Each scan's date and time are the branch's wall clock, with no zone. Line Clear scans in
  Malaysia, whose clock has no daylight saving, so scans are read in `Asia/Kuala_Lumpur`, and a
  delivery gives `delivered_at`.
- A scan's description is its status, as the page shows it: the page rewords a few codes, such
  as Ready for Delivery as Parcel has Arrived, and adds the reason to an undelivered scan. The
  scan code is kept as its provider code and stages it.
- The page leaves out some internal scans, such as delivery run sheets; the adapter leaves out
  the same ones.
- Each scan's own description names the staff member who scanned it, which the page does not
  show. The adapter does not read it, and takes phone numbers out of reasons.
- A branch code is replaced by its place, as the page shows it. The place is required: a scan
  kept once under its code and once under its place would show twice. Places are cached for
  later lookups.
- The page shows the proof of delivery only after the recipient's phone digits; the adapter does
  not ask for it.
- The tracker also searches senders' shipment references. The adapter searches waybill numbers
  only.

## Limitations

- No estimated delivery, weight or service name.
- No failed delivery has been seen live; its wording comes from the page's script.

## Numbers

Line Clear's former tracking form gave W followed by thirteen digits as its example, and an
aggregator's sample of V followed by fifteen digits is on Line Clear's tracker. No rule claims
either layout: a single letter and digits do not point to Line Clear alone. Aggregators also
describe numbers as ZND followed by twelve digits, but no Line Clear source shows that layout.
The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`lineclearexpress.com/tracker?id={number}` opens one waybill on Line Clear's tracking page.

## Testing

`npm run test:carriers:live -- carriers/line-clear`, with `LINE_CLEAR_TRACKING_NUMBER` and
optionally `LINE_CLEAR_UNKNOWN_NUMBER` set outside the repository.
