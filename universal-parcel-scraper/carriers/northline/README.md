# Northline

Northline is an Australian road and rail freight network that carries pallets and general
freight between its depots in every state and territory. Tracked through the lookup its
tracking page makes.

## How it works

1. `direct`: one `GET https://track.northline.com.au/api/track/v3/public/reference?referenceNo={number}`,
   as the tracker's page sends it for the number in its address. It needs no cookie, token, key
   or browser, only an `x-device-id` header holding a UUID: the page makes one up and keeps it,
   and the adapter keeps one for as long as it runs. The JSON reply has the consignment's
   current status, its estimate and its milestones, newest first.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 200 with `data: null` and the message `No result`, which the page
  shows as not found. A request without a device ID gets a `status` with the service's message,
  which is inconclusive. A 404 or a redirect is a moved route.
- The lookup also takes references, so the consignment must name the whole number asked, and
  so must each milestone.

## Notes

- Every clock in the reply ends in `Z`, but holds a wall clock: the page shows the dates with
  UTC getters, and consignment dates are midnight. Each milestone's `branch` field names the
  zone of the branch that recorded it by its abbreviation, such as `AEST` or `AEDT`, which says
  whether daylight saving time applied, so the five Australian abbreviations give the offset.
  A milestone with another abbreviation, or none, keeps its wall clock as `local_time`.
- A history runs across zones, so milestones that all have an instant are ordered by it; the
  reply orders them by wall clock.
- The status value stages each milestone. "Not Available" is a booked consignment before
  pickup, and "Depot Arrival" also follows a delivery run that came back. A consignment
  booked without milestones is read from its own status, as `summary_only`. Its own status
  can lead its milestones to a delivery.
- A depot scan can be listed several times over with the same clock; it is kept once.
- The estimate is a calendar day and is dropped after a delivery. The delivery's instant is
  the delivered milestone's.
- The account code, the sender's reference, and the sender's and receiver's suburbs, states and
  postcodes are not kept.
- No recognition: no detection rule offers Northline's numbers.

## Limitations

- Milestones carry no place, and guest lookups no weight, service or proof of delivery.
- Exception and return values have not been seen; they fall to the shared wording rules.

## Numbers

Northline asks for the consignment note number. Numbers that customers and Northline itself
quote start with a digit and three letters, which vary with the sender or booking channel, and
end in five to eleven digits. Sameday, DHL eCommerce Netherlands, Poste Italiane and others
print the same shape, so no rule claims it. The adapter sends only that layout. The samples
and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker's search opens `track.northline.com.au/status/{number}`, a page of its single-page
app that looks the number up.

## Testing

`npm run test:carriers:live -- carriers/northline`, with `NORTHLINE_TRACKING_NUMBER` and
optionally `NORTHLINE_UNKNOWN_NUMBER` set outside the repository.
