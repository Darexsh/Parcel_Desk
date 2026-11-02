# MailPlus

MailPlus is an Australian courier network of local franchisees that collects parcels from small
businesses for same-day delivery nearby and lodges the rest with partner carriers such as
Australia Post. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://wapp.mailplus.com.au/api/v1/customer/trackings/public/{number}`,
   the lookup the tracker at `track.mailplus.com.au` makes with the number in capitals. It
   needs no cookie, key or browser. The JSON reply has the barcode the parcel is followed
   under, its events oldest first and MailPlus's delivery estimate. When the reply says
   `syncable`, the page asks once more with `?syncable=true`, which makes the tracker fetch the
   partner's newest scans first and takes several seconds; the adapter does the same and keeps
   the first answer when that read fails.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- The API checks the number's layout first. A layout it does not take is HTTP 400 with
  `This barcode is not valid.`, which the adapter reports as invalid input. A number of a layout
  it takes that it does not hold is HTTP 409 with `There are no results for this tracking.`,
  which is not found. A 404 or a redirect is a moved route.
- The reply must name the number asked as its `tracked_barcode`. A MailPlus number of a parcel
  lodged with a partner is answered with the partner's barcode and never repeated, so for a
  MailPlus number the reply may name another carrier's barcode, but not another MailPlus number.
- Recognition makes the same first request, without the refresh.

## Notes

- Each event's `datetime` has milliseconds and an offset, which follows daylight saving, so the
  clocks are instants. The page shows them as the shipment's local time.
- An event's `name` is its status: MailPlus's own steps (`Picked up`, `lodged`), its labels for
  a partner's scans (`Pickup And In Transit`) or the partner's own wording. The name is the
  provider code and stages the event; its `note`, when there is one, is the description, as the
  older page shows it.
- `Ready For Collection` is a collection booked with MailPlus before the sender hands the parcel
  over, so it is registered, not waiting for the recipient. A partner's pre-advice after
  MailPlus collected the parcel moves nothing, so the stage stays with the newest event that did.
- Australia Post's scans come in pairs at the same minute: its own wording and a bare status
  such as `Intransit`. The page lists both, and so does the adapter.
- A barcode other than the number asked is the partner's: it becomes `delivery_tracking_number`.
  The partner is `delivery_carrier` when the reply names it in `carrier`, or when one of its
  events is Australia Post's pre-advice.
- While part of the tracker is down, its `uptime` is not `true` and it shows only collection
  and lodgement scans, so the history is marked as cut.
- The estimate is a range of days, kept until the parcel is delivered.
- The reply can also name the recipient, the collection and delivery suburbs, MailPlus's own
  reference and a delay warning. None is kept.

## Limitations

- No proof of delivery or sender.
- A partner's scans are those MailPlus's tracker relays; the partner's own tracker can hold more.

## Numbers

The tracker gives `MPX` and nine digits as its example tracking ID, and `MPXL` and six digits
beside it among the examples for tracking several parcels at once. `mailplus-au-1` suggests
MailPlus for the first with low confidence, since only that example is public; Colis Privé
takes the same twelve characters. The `MPXL` layout is an open gap: its one example also fits
C Chez Vous. The tracker also takes the barcodes of the carriers MailPlus lodges parcels with,
such as Australia Post's, which stay with those carriers' rules. The adapter takes any number
of six to forty letters and digits with a digit and leaves the layout to the API. The samples
and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker opens one parcel at `/{number}` after a search; its older page opens it at
`/old/{number}`.

## Testing

`npm run test:carriers:live -- carriers/mailplus-au`, with `MAILPLUS_AU_TRACKING_NUMBER` and
optionally `MAILPLUS_AU_PARTNER_NUMBER` (a MailPlus number lodged with a partner) and
`MAILPLUS_AU_UNKNOWN_NUMBER` set outside the repository.
