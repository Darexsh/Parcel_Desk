# Sundarban Courier Service

Sundarban Courier Service is a Bangladeshi courier that carries parcels and documents between
its branches and hubs across the country, for delivery to the door or collection at a branch
counter. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://operation.sundarbancourierltd.com/Home/getDatabyCN` with the
   JSON body `{"selectedtypes":"cnno","selectedtimes":"7","inputvalue":"{number}"}` and the
   `key` header the tracking page's script sends, the same for every visitor. It needs no
   cookie or browser. The reply is a list of shipments, each with its summary and its statuses,
   oldest first.
2. `retry`: one more request when the first fails to reach the service or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- A number the tracker holds nothing for is HTTP 200 with an empty list, which the page reports
  only as an error and a request for the correct format. It never says the shipment does not
  exist, so that answer is inconclusive (`portal_not_found`), not a missing parcel.
- The shipment must name the whole number asked as its `cnNumber`.
- A lookup without the right key gets the JSON string `"UNAUTHORIZED"`. The adapter then reads
  the current key from the tracking page once and keeps it.

## Notes

- Each status's `statusDate` is a day the service writes at midnight, with no zone, so it stays
  a `local_time` day. A clock other than midnight would be kept as the branch's wall clock.
- Domestic statuses come as English wording, such as `Received by Dest.`, which stages them; the
  page turns each into a Bengali sentence naming the branch. International statuses come as
  codes such as `customs_clearance_at_dest`, kept as `provider_code`, with the label the page
  gives them as wording.
- A status's location is the branch it happened at, in Bengali as the page shows it.
- `Ready for C/D` is a parcel waiting at a branch counter: that branch is the pickup point, also
  after a delivery that follows it directly.
- The reply also carries the recipient's phone, which the page shows masked, the contents, the
  booking and destination branches, the lot quantity, vehicle, bag and manifest numbers and
  remarks, and fields for the sender's and recipient's names and addresses. None of them is
  kept.
- No recognition: the tracker never says a number is unknown, and fourteen digits are a shape
  many carriers print.

## Limitations

- No times, estimate, weight or service.
- The tracker also searches by the sender's or recipient's phone and by reference; the adapter
  looks up CN numbers only.
- The page expands a CN number shortened with a dot from a fixed prefix; the adapter takes the
  whole number only.

## Numbers

Sundarban CN numbers are fourteen digits. Its tracking page shows them in archived lookups and
expands a shorthand with a dot into fourteen digits, or seventeen for a sub-CN. The adapter
sends fourteen or seventeen digits. Many carriers print fourteen-digit runs, so no rule claims
them.

## Links

The tracking page reads the number from `cnnumber` on `operation.sundarbancourierltd.com` and
on its former address `tracking.sundarbancourierltd.com`, which now redirects there.

## Testing

`npm run test:carriers:live -- carriers/sundarban-courier`, with
`SUNDARBAN_COURIER_TRACKING_NUMBER` and optionally `SUNDARBAN_COURIER_UNKNOWN_NUMBER` set
outside the repository.
