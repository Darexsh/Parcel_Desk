# Pactic

Pactic is a Hungarian shipping platform for online shops. It books parcels on partner couriers
(Pactic Delivery) and runs a cross-border network of its own, which gathers parcels at its hubs
and hands them to a local courier in the destination country as domestic parcels (Pactic
Cross-border). Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://dashboard.pactic.com/api/Meta/tracking?waybill={number}`, the
   lookup the tracking page makes. It needs no cookie, token, key or browser.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try
   gets half of the budget, so the retry fits in the rest.

- A waybill the tracker does not know gets HTTP 200 with an empty list, read as not found. A
  waybill its validation refuses gets HTTP 400, which leaves the answer open. A redirect or a
  404 is a moved route, a 403 or a firewall page in place of the JSON is a challenge, and a 429
  is a rate limit.
- The reply is a list of parcels, and one must name the whole number asked. An archived reply
  wrapped the list in `{status, data, error}` and kept the waybill and link in the status list;
  both shapes are read.
- Recognition makes the same request, for Pactic's own waybills only.

## Notes

- Each status is a Pactic code and a date to the minute. The page titles the codes from two
  public lists, `/api/Meta/statuses` and `/api/Meta/translations`. The adapter keeps the English
  title, with the code as the provider code, and the status map stages the codes. A code the
  lists do not title keeps its number as wording and moves no stage. Pactic files a partner
  courier's scans under its own codes too.
- Dates name no zone, so they stay `local_time`, and consumers fall back on the catalog's
  Budapest clock. Pactic's own steps and the partner's scans need not share a clock: in one
  Romanian delivery the courier registered the parcel two hours after Pactic created it, to the
  second, as a Bucharest clock reads a UTC one.
- A parcel's tracking link names the delivery carrier when its address names one carrier and
  holds the number asked or another waybill of the history, which then becomes the delivery
  number. Pactic's own deliveries have no link.
- The collection contact's name, email and phone, the return waybill and each status's longer
  description are not read.

## Limitations

- No places, instants, expected delivery or proof of delivery.
- A partner whose link names no single catalog carrier is not named.

## Numbers

Pactic's own waybills are C, four digits, the time the order was created as `YYMMDDhhmmss`, and
six digits. No other carrier issues the layout, so the rule has high confidence, and it checks
the date and time fields.

Pactic Delivery parcels travel under the partner courier's own number. The tracker answers for
those too, but the partner's own tracker gives its history with its clock, so detection and
recognition leave them to the partner, as [Sameday](../sameday/README.md) does. Asked for one
directly, the adapter still answers and names the partner from the link.

## Links

A link to the tracking page with the waybill in its `waybill` parameter, or in `waybillNumber`
under a language path as older links have it, opens one parcel. A partner courier's number in
such a link is detected on its own.

## Leads

`GET https://api.pactic.com/webservices/shipment/tracking/track.ashx?waybill={number}`, which
Pactic's WordPress plugin calls, also needs no key. It lists the same statuses oldest first, to
the second, beside each one's raw code: Pactic's own step names or the partner's codes.

## Testing

`npm run test:carriers:live -- carriers/pactic`, with `PACTIC_TRACKING_NUMBER` and optionally
`PACTIC_UNKNOWN_NUMBER` set outside the repository.
