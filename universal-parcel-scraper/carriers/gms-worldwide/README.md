# GMS Worldwide Express

GMS Worldwide Express is a domestic courier network based in Bengaluru, India, with regional
offices, branches and franchisees across the country. Tracked through its tracking page's own
lookup.

## How it works

1. `direct`: one `GET https://www.gmsglobe.com/webapi/get-consignment.php?cnno={number}`, the
   lookup the tracking page on gmsworldwide.com makes for the number in its address. It needs
   no cookie, token, captcha or key. A consignment's reply names its number and has a summary
   status and the scans, newest first, each with a day, a clock, the GMS office that recorded
   it and a wording.
2. `retry`: one more read when the first fails to reach GMS or hangs, inside the budget.

- An unknown number is HTTP 200 with `{"Status":"NO DATA"}`, which the page reports as an
  invalid consignment number. That answer names no number, and the lookup gives it to a
  request without one too, so only a nine-digit number is sent. Any other answer is
  inconclusive. A page in place of the reply, even with HTTP 200, is a challenge or a changed
  reply, never a missing consignment. A 404 or a redirect is a moved route.
- A consignment must name the whole number asked in `@attributes.trackingNo`.
- The page can also look a number up as a customer reference (`refno`). The adapter sends
  consignment numbers only.
- Recognition makes the same request.

## Notes

- The reply is converted from XML: an empty field is `{}`, and a lone scan comes as an object
  rather than a list.
- Each scan's clock is a wall clock to the second, such as `06 Mar 2026` and `12:48:05 pm`,
  with no zone. Each scan names the GMS office in India that recorded it, and India keeps
  UTC+5:30 all year, so the clocks are read in `Asia/Kolkata` and each scan gets a `time`, as
  for ST Courier.
- Scans come without a code, so their wordings stage them. `BOOKED AT …` is the acceptance at
  the booking office, and `RECEIVED BY …` and `Forwarded TO …` are moves between offices; the
  shared wording rules know none of them. The last office's `Forwarded to <town>` comes with
  the delivery or just before it, and stays in transit.
- The scans set the stage, not the summary's status, which can lag them: a summary still said
  In Transit under a delivery recorded months after the last hub scan. Rows on one clock come
  in either order, so a delivery among them is the newest. A consignment without scans is a
  summary-only answer.
- A scan's office, as `<city> RO APEX, <city>` or `<locality> BO, <city>`, is its location. A
  delivery's wording loses whom it names after "to" or "by", and every wording loses phone
  numbers.

## Limitations

- No expected delivery, weight, service name or provider code. Only the number, the scans and
  the summary's status are kept; the reply's other details are not.

## Numbers

Complaints give nine-digit consignment numbers, and the adapter takes nine digits only. Nine
digits are printed by many carriers, so no rule claims them and preflight does not ask GMS: a
number reaches the adapter when the user, a link or a provider names the carrier. The samples
and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking form on the home page opens `/shipment-tracking` with the number as
`tracking_no` and the lookup type as `tracking_type`.

## Testing

`npm run test:carriers:live -- carriers/gms-worldwide`, with `GMS_WORLDWIDE_TRACKING_NUMBER` and
optionally `GMS_WORLDWIDE_UNKNOWN_NUMBER` set outside the repository.
