# American West

American West (AWest) is a furniture and e-commerce home delivery carrier based in San Luis
Obispo, California. Its I-Trek tracker, which Freightgate runs, shows a shipment's pickup, its
arrival at the final mile agent, the delivery appointment and the delivery. Tracked through the
page the tracker's search opens.

## How it works

1. `direct`: one `GET https://awest.freightgate.com/cgi-bin/tarifftrek5.1/itrek.cgi` with
   `database=awest&type=submit&interface=pltx&open_interface_search=Search+Now&open_text={pro}&SearchOn=open_billno`,
   the search of the tracker's `Pro Number` option. It needs no cookie, token, key or browser.
   The page assigns the shipment's row to `window.JSONReport` for its own script to render, and
   the adapter reads that object.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- A pro number the tracker finds nothing under is the notice `no records found matching your
  criteria`. The tracker only finds shipments picked up in the past 90 days, and an older
  shipment or one not picked up yet gets the same notice, so it is inconclusive
  (`portal_not_found`), not not-found. The notice counts only when the search the page keeps in
  its form is the number asked; otherwise it is inconclusive too.
- The adapter sends whole pro numbers of two letters and seven digits only. The page's own
  follow-up search matches the start of a pro number, and the tracker also searches by bill of
  lading, purchase order and phone number, which the adapter never does. A report is kept only
  when it holds exactly one shipment and that shipment's pro number is the one asked; anything
  else is inconclusive and nothing from it is kept.
- A redirect, a 404 or a 410 is a moved page, and a firewall or bot check page in place of the
  page is a challenge.
- No recognition: the notice for an unknown number is the one older shipments get, so a lookup
  cannot tell an American West pro number from another carrier's.

## Notes

- The page gives days without a clock or zone. Milestones stay days in `local_time`.
- The milestones are the pickup, the arrival at the final mile agent, the first call to the
  customer to book the delivery, which moves nothing, and the delivery. On one day the further
  milestone comes first. The page's progress rail decides the stage only when it is further on
  than every milestone, and then has no day.
- Until the delivery, the estimate is the delivery appointment's day, else the ETA to the
  customer. A day before the newest milestone's is stale. The ETA to the final mile agent is the
  hub's arrival, not a delivery estimate, and is not read.
- The pickup's and the delivery's places are kept as a town and its state; anything else in
  those fields is not kept.
- The bill of lading and purchase order numbers, the pieces, the weight, which has no unit, the
  last town and the office's contact details are not kept.

## Limitations

- No scan time as an instant, no sender, recipient, signer or proof of delivery.
- Shipments picked up more than 90 days ago are not found.
- A pro number reaches the adapter when it is filed under American West or opened from an I-Trek
  link: other carriers print two letters and seven digits too, so no rule claims them and
  preflight does not ask it.

## Numbers

Archived lookups on the tracker show pro numbers of two letters and seven digits. The samples
and their sources are in [`numbers.json`](numbers.json).

## Links

`awest.freightgate.com/cgi-bin/tarifftrek5.1/itrek.cgi` with the number in `open_text` and
`SearchOn=open_billno` opens one shipment; archived lookups on the tracker use it. The library
reads the number from `open_text`.

## Testing

`npm run test:carriers:live -- carriers/american-west-express`, with
`AMERICAN_WEST_EXPRESS_TRACKING_NUMBER` and optionally `AMERICAN_WEST_EXPRESS_UNKNOWN_NUMBER`
set outside the repository.
