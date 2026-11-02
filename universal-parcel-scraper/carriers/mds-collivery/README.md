# MDS Collivery

MDS Collivery is a South African courier. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://collivery.net/ajax/waybill/tracking/{waybill}` with
   `Accept: application/json`, as the tracking page sends it. It needs no cookie, token, key or
   browser. The JSON reply names the waybill and gives the current status over the history,
   oldest first.
2. `retry`: the same request once more after a network failure or a hang.

- An unknown waybill is HTTP 404 with the message `Document not found`, which the page reports
  as not found. A missing route answers 404 with an empty message, and without the JSON
  `Accept` header the site's HTML 404 page; both are a moved route. A bot check's page is a
  challenge.
- The reply must name the waybill asked.
- Collivery's integration API needs an account, so the adapter reads the public page's lookup.
- Recognition makes the same request.

## Notes

- The history gives each scan as Unix seconds. They match the South African wall clocks the
  API documentation's status history gives for the same waybill, so scans are instants, shown
  at `+02:00`.
- The history writes its own lines for Collivery's statuses and leaves some out, such as the
  driver leaving with the parcel or the booking's completion. The current status uses the
  status names of the API documentation, so it sets the stage; a booking change or billing
  status leaves it to the newest staged scan.
- A `Received in … branch` line gives its branch as the location. A booking change and billing
  move nothing.
- The reply gives the collection and delivery addresses, which name the sender and the
  recipient, a progress rail, a fraud warning and support links; none is kept. A line loses a
  clause naming who signed for the parcel, and phone numbers.

## Limitations

- No estimate, weight, service name or proof of delivery. The page can show an estimate, but no
  public waybill showed one, so its format is unknown and it is not read.
- Waybills are short digit runs many carriers share, so no detection rule claims them: a lookup
  names Collivery or comes from its tracking link.

## Numbers

Collivery tracks by waybill number, its booking id. The waybills in its API documentation are
seven digits; the adapter accepts six to nine digits without a leading zero. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

Collivery's integration guide shares one waybill as `collivery.net/tracking?waybill={number}`,
and its tracking page loads that waybill's history. The former tracker took the number as
`waybillNo` on `quote.collivery.co.za/tracking.php`.

## Testing

`npm run test:carriers:live -- carriers/mds-collivery`, with `MDS_COLLIVERY_TRACKING_NUMBER` and
optionally `MDS_COLLIVERY_UNKNOWN_NUMBER` set outside the repository.
