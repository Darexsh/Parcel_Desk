# OCS ANA Group

OCS (Overseas Courier Service) is the ANA group's international express courier, based in
Japan. Tracked through its history page, with the lookup its tracking form used to open for the
delivery company a waybill is handed to.

## How it works

1. `direct`: two requests at once, with no cookie, token, key or browser.
   - `GET https://webcsw.ocs.co.jp/csw/ECSWG0201R00003P.do?cwbno={number}` with
     `Accept-Language: en`, the history page, in English. Without that header it answers in
     Japanese. The answer rests on this page alone.
   - `GET https://www2.ocsworldwide.net/ExpTracking/cwbCheck.php?cwbno={number}`, the lookup
     the tracking form on OCS's site opened. Its reply is a refresh to where the waybill is
     tracked: OCS's history page, or the tracker of the Japanese delivery company it was
     handed to. It only names that company, so it gets three seconds, and a lookup that fails
     or takes longer names none. OCS took its tracking form off the lookup after a
     vulnerability notice, and its host stopped answering.
2. `retry`: the history page once more when it fails to reach OCS or hangs, with the lookup
   beside it. The first try gets half of the budget, so the retry fits in the rest.

- Both pages accept several comma-separated waybills. The adapter sends one whole waybill,
  and the summary and the detail must name it. A refresh for another waybill names no company.
- An unknown waybill is HTTP 200 with `No items were found for the search condition.` (its
  Japanese wording too), which is not found. Another message, such as a refused format, is
  inconclusive. A 404 or a redirect from the history page is a moved route.
- A summary with several shipments for one waybill is inconclusive.
- Recognition makes the same requests. With no detection rule, preflight does not ask OCS.

## Hand-offs

OCS hands imports to a Japanese delivery company in Japan, usually Sagawa Express, which keeps
the waybill as its own slip number. While that company holds a waybill, the lookup refreshes
to its tracker with the number in the address; OCS's page still holds the waybill's history,
including the company's scans, but does not name the company. The adapter reads OCS's page in
every case and never the partner's tracker. When the refresh names Sagawa Express or Yamato
Transport with a number of their shape, it reports them as the delivery carrier and its
number. If OCS's page then does not hold the waybill, the result is that hand-off alone, in
transit and summary only. Any other destination names no partner.

## Notes

- Each scan's clock is a wall clock to the minute with no zone. An import's history mixes
  stations abroad and in Japan, so the clocks stay `local_time`.
- A scan's wording is the activity, then its memo when it adds something, as
  `Arrived at Facility: Arrived at Service Center`. The activity stages the scan.
- The delivery company's own scans share one activity, `Status Updated by Delivery Contracted
  Company`, and carry their status in the memo, which stages them. Its pickup is in transit.
- The delivery memo runs the delivery company's slip number into its wording. Long digit runs
  and a clause naming who took the shipment are dropped.
- Shipper and receiver are written `CITY/COUNTRY`. Only the receiver's country is kept. The
  progress rail, piece count, item type and volumetric weight are not kept.

## Limitations

- No estimated delivery or service, and no scan time as an instant.
- The page drops a shipment some time after delivery, which then reads as not found.
- The delivery company is named only when the lookup answers, and only while the company holds
  the waybill. Without the lookup, a waybill OCS's page does not hold reads as not found.

## Numbers

OCS tracks a shipment by its waybill (CWB) number. Lookups archived from its tracker show
eleven-digit waybills for exports from Japan and twelve-digit waybills for imports into
Japan; the history page itself accepts eleven or twelve half-width digits. Most of them end
in an airline-style check digit (the leading digits modulo 7), as the numbers of Blue Dart,
Yamato and Sagawa do. Neither length points to OCS alone, so no rule claims them. The samples
and their sources are in [`numbers.json`](numbers.json).

## Links

The link opens OCS's history page for one waybill, the page the tracking link on OCS's home
page opens. It shows the history of a waybill a delivery company holds too.

## Testing

`npm run test:carriers:live -- carriers/ocs-ana`, with `OCS_ANA_TRACKING_NUMBER` and
optionally `OCS_ANA_UNKNOWN_NUMBER` set outside the repository.
