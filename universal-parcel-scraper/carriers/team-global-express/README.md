# Team Global Express

Team Global Express, formerly Toll's Global Express business, carries parcels and freight across
Australia and New Zealand through the former Toll IPEC road network and the former Toll Priority
network. Tracked through MyTeamGE's quick search and the shipment page it opens, and in New
Zealand through NZ National Networks' Fast Tracker.

## How it works

1. `direct`: `GET https://www.myteamge.com/search-shipment` with the portlet fields MyTeamGE's
   track box sends and the number as `company` and `_searchportlet_WAR_searchportlet_shipmentReferences`.
   The HTML answer heads its rows with the term searched and how many shipments matched; each
   row carries the id its shipment page opens with. Then
   `GET https://www.myteamge.com/web/guest/shipment-details?consignmentId={id}`, whose script
   holds the shipment (`courierStopList`) and its scans (`eventsBeanList`) as JSON. A number of
   New Zealand's layout is first asked of Fast Tracker:
   `GET https://fasttracker.teamglobalexp.co.nz/fast-tracker.aspx?fasttracker_action=search&ConsignmentNumber={consignment}`,
   whose table has a row per item, `{consignment}-NN`, each linking its page by
   `?ConsignmentDetailId={id}`. Each item's page lists its scans. Only once Fast Tracker has no
   result is MyTeamGE asked. None of these needs a cookie, token, key or browser.
2. `retry`: one more attempt after a failed connection or a timeout. An HTTP status is never
   sent again.

- An unknown number gets the search's `0 shipments` answer, which the page reports as not found,
  and Fast Tracker's notice that names it. A shipment page without the shipment is
  inconclusive. A 404 or a redirect is a moved route.
- AWS's firewall answers HTTP 405 with a CAPTCHA after a burst of lookups, and the page then
  says the address made too many requests, so the adapter reports it as rate limited. A 403, a
  firewall action header or a challenge script is a browser check.
- The search must echo the number, and the row it uses must have the number as its shipment
  number, else among its references. The shipment page must name the same shipment and id.
  Several matching rows are inconclusive. A match through a reference reports the shipment's own
  number as the canonical one.
- Fast Tracker matches whole numbers only. Its notice must name the consignment asked, and each
  item row and page the consignment and the item.
- Recognition makes the same requests.

## Notes

- A scan's `dateTimeStamp` is the clock the page shows: the time where the scan happened, or
  Sydney's when the system does not know that zone, and it never says which. The clocks stay
  `local_time`. Item scans also carry an `aestEventDateTime`. Its name says Australian Eastern
  Standard Time, but during daylight saving it follows Sydney's summer clock, so no instant is
  derived from it.
- A scan's code stages it. The former IPEC network writes a scan type, `$$` and a reason
  (`1$$9`); the former Priority network a number, with a reason after `$$` on some. A code the
  map does not know falls to an attempted delivery the scan's exception names, then to the
  milestone MyTeamGE files the scan under, then to its wording.
- The shipment's milestone settles a delivery, a collection by the receiver or a cancellation.
  A partial delivery stays in transit.
- `IN SYSTEM` and `SERVICE ALERT APPROVAL` are a system and a desk, not places, so those scans
  have no location.
- Fast Tracker's scans carry a wording, a branch and New Zealand's wall clock, which is dated on
  New Zealand's time. Its wordings stage them. The items' scans are kept together, newest first;
  a consignment is delivered once every item read is, and until then stays in transit.
- Fast Tracker's sender, places, references, the receiver who signed and the signature are not
  kept. Its service, estimate and the items' weights are.
- The signatory, the sender's references, item ids and the sender's and receiver's suburbs are
  not kept. The receiver's country is.
- The delivery page for JB Hi-Fi orders on `teamglobalexp.com/myparcel` is not used: it shows
  milestones without scans, alongside the recipient's name and address.

## Limitations

- MyTeamGE gives no offset timestamps and no delivery time as an instant.
- Fast Tracker opens a page per item, so a consignment of more than ten items is read by its
  first ten and its history is marked as cut.
- The search also matches references and card numbers that a row does not show. Such a match is
  inconclusive.

## Numbers

Team Global Express tracks shipment, consignment and item numbers in MyTeamGE. Numbers seen in
reviews and archived lookups are thirteen digits, twelve digits, nine digits, or a
four-character sender prefix and six digits; deliveries for JB Hi-Fi also use other prefixes.
New Zealand consignments are a four-letter sender prefix and seven digits; their labels print
five more digits, which are cut before Fast Tracker is asked. All of these are shapes other
carriers print: four letters and six digits is C Chez Vous's layout, and the digit runs are
shared widely. No rule claims them, so a lookup needs the carrier named. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

MyTeamGE reads a number from `externalSearchQuery` on `www.myteamge.com/`, and the delivery
page for JB Hi-Fi orders reads one from `shipmentID` on `teamglobalexp.com/myparcel`. Fast
Tracker reads one from `ConsignmentNumber` on `fasttracker.teamglobalexp.co.nz/fast-tracker.aspx`.
All appear in archived lookups.

## Testing

`npm run test:carriers:live -- carriers/team-global-express`, with
`TEAM_GLOBAL_EXPRESS_TRACKING_NUMBER`, `TEAM_GLOBAL_EXPRESS_NZ_TRACKING_NUMBER` and optionally
`TEAM_GLOBAL_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
