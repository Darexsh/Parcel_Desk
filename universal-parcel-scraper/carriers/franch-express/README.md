# Franch Express

Franch Express is a domestic courier network in India, based in Chennai. Tracked through the AWB
History page of its ERP, which its staff app opens for a number.

## How it works

1. `direct`: two requests to `www.erpfranchexpress.com`, as the AWB History form makes them.
   - `POST /inc/cis_ajax/jquery_encryption.php` with the form's query as the field `url`,
     `url=keyword%3D{number}`. It needs no cookie, captcha or account, and answers a URL-safe
     token for the query.
   - `GET /api-tracking.php?data={token}`, the page the form opens next. Its HTML names the
     number and lists the consignment's scans, newest first.
2. `retry`: a request that fails to reach the service, or hangs, is sent once more within the
   budget.

- An unknown number gets the page's "Consignment Number / Reference Number not found..!",
  which is not found. A page that shows neither a consignment nor that answer, such as "Please
  enter AWB number..!" when it reads no number from the token, is inconclusive.
- The page's heading names the consignment's number, which must be the number asked: the page
  also finds a consignment by its reference number, under the consignment's own number.
- A token of another shape, a page without the form or a scan without its clock or wording is
  a schema failure. A bot or firewall page in place of either reply, or a 403, is a challenge.
  A redirect or a 404 is a moved route.

## Notes

- The tracking page on `franchexpress.com` posts the number as JSON to its `proxy.php`, which
  answers `{"status":"error","data":[]}` for every number, including consignments the AWB
  History page shows, so the adapter does not use it.
- Each scan's clock is a wall clock to the minute, such as `Sep 25, 2025 07:24 PM`, with no
  zone. Every scan is at a Franch Express branch or hub in India, which keeps UTC+5:30 all year,
  so the clocks are read in `Asia/Kolkata` and each scan gets a `time`, as for ST Courier.
- Scans come without a code, so their wordings stage them. `Received at Hub` is in transit,
  which the shared wording rules would read as an acceptance. `Holding at Hub` is an exception.
  A return to origin, worded `RTO …`, is an exception until it is delivered back, then returned.
- A scan's line under the wording is its place, as `Sample hub, TN`. A line of another shape
  could name a person, so only a branch or hub with its state's code is kept.
- `Forwarded to …` hands the parcel to a partner carrier, and the line under it gives the
  partner's waybill number with a link to the partner's tracker. The partner and its waybill are
  reported only when the wording names a catalog carrier, the link does not point at another
  carrier, and the waybill is of a shape that carrier issues.
- A delivery's wording loses the name of who took the parcel, and every wording loses phone
  numbers. The lines with the scan's code, the consignment's kind, count and weight, a hold's
  reason and the staff member's name, and the proof-of-delivery images, are not kept.

## Limitations

- No expected delivery, origin, destination, booking time or sender.
- The page no longer shows some older consignments; one it does not show gets the same answer
  as an unknown number, so not found also covers it.

## Numbers

Franch Express air waybill numbers are eleven digits. The AWB History field takes digits only,
eleven at most, and the adapter refuses any other length. Customers quote eleven-digit numbers
in complaints about the courier, and an archived lookup on its older tracker carries one. No
rule claims them: many carriers print eleven-digit numbers, so preflight does not ask Franch
Express and a number reaches the adapter when the user, a link or a provider names the carrier.
The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page and the AWB History page take the number in a form, and the AWB History page
opens with a token its lookup derives from the number, so no address built from the number
opens one parcel. Links to the older tracker on `erp.franchexpress.com`, which no longer
answers, carry the number in `keyword`.

## Testing

`npm run test:carriers:live -- carriers/franch-express`, with `FRANCH_EXPRESS_TRACKING_NUMBER`
and optionally `FRANCH_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
