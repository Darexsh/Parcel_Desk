# Next Level

Next Level is a Bulgarian courier that delivers across Bulgaria and, through subcontractors, to
Greece, Romania and other Central and Southeastern European countries. Tracked through the lookup
its tracker page makes.

## How it works

1. `direct`: one `POST https://api.nextlevel.delivery/v1/track` with `{"ids": [number]}`, as the
   script of `nextlevel.delivery/track` sends it for the number in its address. The page sends it
   without a key, cookie or account, and so does the adapter. The answer is one list of movements
   per number asked, oldest first.
2. `retry`: one more try when the request fails to reach Next Level or hangs. The first try gets
   half of the budget.

- A number the tracker does not have gets an empty list, and the page shows nothing under the
  number. That list is read as not found.
- The lookup answers every number with HTTP 200, so a 404 is a moved route. A bot check's page is
  a challenge, and a reply that is not one list of movements is a changed schema.
- Every movement must name the number asked as its waybill.

## Notes

- Each movement names the subcontractor's waybill too, and repeats the waybill while no
  subcontractor is involved. The tracker also finds a shipment by the subcontractor's waybill.
  Such a reply is the subcontractor's shipment and stays inconclusive here.
- A subcontractor's waybill is reported as the delivery tracking number. The reply does not name
  the subcontractor, so no delivery carrier is reported.
- The map reads the status id: the tracker labels each id in Bulgarian, and gives the pickup for a
  return the label of a courier's collection. The subcontractor's acceptance has no id and is read
  by its description. A movement's description is its wording.
- Clocks are written `YYYY-MM-DD HH:mm:ss`. Next Level's own movements are read on Sofia time, and
  stay `local_time` in the hour the autumn change repeats or the spring change skips. From the
  subcontractor's acceptance on, the clocks can be another country's, so they stay `local_time`,
  and the reply's order stands.
- Places are offices and towns. The postcode after a town is dropped, and so is a place holding
  another digit, which a street would carry. A movement still at the sender can name the sender's
  site, and a delivery, an attempt or a return can happen at an address, so their places are not
  kept.
- The reply names the person who scanned each movement, which the page does not show, and the
  page adds free-text comments. Neither is kept, nor a return shipment's original waybill.

## Limitations

- No delivery estimate, weight, sender, recipient or subcontractor name.
- No instants for the subcontractor's movements.

## Numbers

Next Level's API reference shows thirteen-digit shipment numbers and an eight-digit number for a
return shipment, and the tracker answers both. No rule claims them: thirteen and eight digits are
plain digit runs other carriers print too, so recognition does not ask Next Level. The adapter
sends thirteen or eight digits and refuses anything else without a request. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The tracker opens one parcel at `nextlevel.delivery/track?awb={number}`, the tracking link the
API returns. The page also takes several numbers separated by commas in `awb`.

## Testing

`npm run test:carriers:live -- carriers/next-level-delivery`, with
`NEXT_LEVEL_DELIVERY_TRACKING_NUMBER` and optionally `NEXT_LEVEL_DELIVERY_UNKNOWN_NUMBER` set
outside the repository.
