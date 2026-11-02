# TNT Italy

TNT Italy is TNT's national courier network in Italy, run by TNT Global Express, now part of
FedEx. Its waybills, the lettere di vettura, cover parcels sent within Italy; TNT's international
consignments belong to [TNT](../tnt/README.md). Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://www.tnt.it/tracking/getTrackXML.html` with the form body
   `wt=1&consigNos={number}`, as the tracking page sends it. It needs no cookie, token or
   browser. The XML reply lists every shipment that carried the waybill, each with its scans
   newest first.
2. `retry`: the same request once more after the first failed to reach tnt.it or timed out,
   with the rest of the budget.

- An unknown waybill is error `00015`, "Nessun dato rientra nei criteri di scelta", which the
  page reports as not found. A 404 or a redirect is a moved route.
- A shipment FedEx carries is error `40000`, for which the page links to fedex.com. That answer
  is inconclusive.
- Akamai sits in front of the site. Its Access Denied page is a challenge, with HTTP 403 or 200.
- The reply must list a shipment under the waybill asked.
- Recognition makes the same request.

## Notes

- A scan's date and time are a depot's wall clock to the minute, without a zone and with the day
  and month's leading zeros dropped. Every scan is at a depot of the Italian network, so they are
  read in Europe/Rome time. The delivered time is the delivery's own clock, to the second.
- Waybills are reused. The reply lists every shipment under the number, and the one with the most
  recent scan is the parcel.
- A scan's depot is its location only where the reply marks it for display, as the page does. A
  parcel left at a FedEx Location has no depot until the courier collects it.
- Code `65` is a delay at the destination depot, not a delivery attempt, so it stays in transit.
- The reply's sender, recipient, sender's reference, parcel count, weights and signatory are not
  kept.
- tnt.com's tracker refuses a national waybill and points to tnt.it.

## Limitations

- No expected delivery: the reply's due date comes back empty.
- A parcel released from storage under a new waybill is not followed to that waybill.
- The tracker also takes a parcel's 15-digit reference (NCOL), which the adapter does not: the
  reply names only the waybill, so it cannot show that the parcel is the one asked.
- OnTrac's high-confidence rule claims numbers starting `LA`, `LE`, `LH`, `LI`, `LN` or `LX`, so
  waybills from TNT Italy branches with those letters reach this adapter only when filed under
  TNT Italy.
- Older shipments drop out of the tracker, which then answers `00015` as for an unknown waybill.

## Numbers

A national waybill is two identifying letters and eight digits, as the tracking page and TNT's
tracking guide give it. Labels add a check digit after a dash, which the guide says to leave out.
tnt.it publishes no list of branch letters, so `tnt-it-1` offers any two letters and eight digits
as a low-confidence candidate and recognition asks the tracker. DHL eCommerce Spain, Swiss Post
Cargo and Prompt Xpress numbers share that shape. Normalization drops the dash, which leaves a
GLS Italy shape, so `tnt-it-check` offers TNT Italy first only when the check digit is typed after
a dash, and the adapter and the tracking link drop the check digit. TNT does not publish how it is
computed. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/tnt-it`, with `TNT_IT_TRACKING_NUMBER` and optionally
`TNT_IT_UNKNOWN_NUMBER` set outside the repository.
