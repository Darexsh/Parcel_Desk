# YCS Logistics

YCS音速物流 is a Taiwanese logistics company with its own delivery fleet and stations across
Taiwan. It also clears and delivers cross-border parcels, and hands some of them to HCT
Logistics for delivery. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://system.ycs-express.com/userSearchTrack` with the body
   `{"cargoNumbers":["{number}"]}`, as the tracking page sends it. It needs no cookie, token, key
   or browser. The JSON reply lists the shipments found under the numbers asked, with their
   details and scans, oldest first.
2. `retry`: the same request once more after a network failure or timeout. The first try gets
   half of the budget.

- An unknown number is HTTP 200 with `search_status` 0, which the page reports as no such order
  number (`查無訂單號碼`). A 404 or a redirect is a moved route.
- A reply with `success` false is the service refusing the request itself, which the page shows
  as an alert, so it is inconclusive.
- The shipment must be listed under the number asked and name it as its bill or piece.
- Recognition makes the same request. No detection rule offers YCS, so recognition is not asked
  until one does.

## Notes

- Each scan's clock is the one the page shows: `currentDate`, else when it happened (`Date1`),
  else when it was entered (`Date2`). YCS works within Taiwan, which has one zone without
  daylight saving, so clocks are read in Taipei time.
- YCS's own scans have a short label, such as `轉運中`, and the station in charge as location.
  Each has a numeric code, but one code covers several steps, so the label stages the scan.
- Rows marked `agents` are HCT's sentences, which YCS relays for the parcels HCT delivers. They
  are placed at the HCT branch the sentence names, not at the YCS station that handed the parcel
  over. HCT's intake is a step on the way, since YCS has already picked the parcel up. The rows
  carry no HCT number, so there is no hand-off.
- The day a station expects to deliver, which YCS sets when it sends the parcel on, is the
  estimate until the parcel is delivered.
- A bill of several pieces lists each piece's scans under its own number, the bill's eleven
  digits and two more. The bill's number gets every piece's scans in one history, a scan they
  share once; a piece's number gets that piece's.
- The sending company is kept. The staff who entered each scan, the sender's order number, the
  piece count, the weight and size, and the link to a return shipment are not.

## Limitations

- No service, recipient or proof of delivery.
- Only YCS's own bill and piece numbers are tracked, not a sender's order number.

## Numbers

A YCS bill number is eleven digits; a piece's number adds two digits, `00` on a bill of one
piece. Many carriers print the same lengths, so no rule claims them.

## Links

YCS's [tracker](https://system.ycs-express.com/search_track) looks numbers up from the page, so
no address opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/ycs-logistics`, with `YCS_LOGISTICS_TRACKING_NUMBER` and
optionally `YCS_LOGISTICS_UNKNOWN_NUMBER` set outside the repository.
