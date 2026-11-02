# Forward Air

Forward Air is a US expedited less-than-truckload carrier. It moves freight between its stations,
mostly for air freight forwarders, and can collect it from the shipper and deliver it to the door.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://api-prod.forwardair.com/tracking/shipments?numbers={number}`, as
   the page at `forwardair.com/tracking?numbers={number}` makes it. It needs no cookie, token, key
   or browser. The JSON reply holds the shipments found, each with its summary and its scans,
   newest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- The service answers HTTP 418 to a request that does not name the site as its referrer, so the
  adapter sends the page's origin and referrer. A 418 counts as a block.
- A waybill it does not know is HTTP 200 without results and with `No waybills found. {number}`,
  which the page shows as an alert. Any other empty answer is inconclusive; a 404 or a redirect
  is a moved route.
- Forward Air reuses waybill numbers, so one can hold shipments years apart, and the tracker also
  finds a shipment by its customer's reference. Only a shipment whose `AirbillNumber` is the
  number asked counts, and the newest of those is read. An answer only by reference is
  inconclusive.
- Recognition makes the same request.

## Notes

- Each scan's `RecordDate` is the station's wall clock to the minute, and `TimeZoneCode` names
  its US zone. `ET`, `CT` and `PT` scans become instants there. `MT` stays a wall clock in
  `local_time`, since Arizona keeps standard time all year and the label does not say whether
  the station is there; so does a scan without a label, such as the booking's.
- The `statusCode` (`ARRD`) stages a scan and its `StatusDescription` is the wording.
  `Recovered` (`COMP`) is the consignee collecting the freight at the destination station, the
  end of a station-to-station shipment, so it counts as a delivery like `Delivered`. A scan
  recorded after a delivery does not undo it. The invoice that follows moves nothing.
- The estimate is the day the page shows: the end of the delivery window when there is one, else
  the day the freight is due at the destination station. The delivery instant is the delivery
  scan's. The weight is kept when the reply gives it in pounds.
- A scan's location is its station code, such as an airport's, as the page shows it.
- The page shows who recorded each scan as its signatory; the reply also names the consignee's
  signer, the paying customer's account and the customer's reference. None of them is read, nor
  are the manifest numbers and piece counts.

## Limitations

- No service, sender or recipient.
- A waybill reaches the adapter when it is filed under Forward Air or opened from a Forward Air
  link: eight digits are shared by many carriers, so no rule claims them and preflight does not
  ask it.
- A shipment whose waybill was reused is shown as the newest shipment under that number.

## Numbers

Forward Air tracks freight by its waybill (airbill) number, which its help pages describe as
eight digits. Lookups archived from its tracking page show eight-digit waybills; the samples and
their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page reads waybill numbers from `numbers` on `forwardair.com/tracking` and looks
them up straight away. The library reads the number from that address.

## Testing

`npm run test:carriers:live -- carriers/forward-air`, with `FORWARD_AIR_TRACKING_NUMBER` and
optionally `FORWARD_AIR_UNKNOWN_NUMBER` set outside the repository.
