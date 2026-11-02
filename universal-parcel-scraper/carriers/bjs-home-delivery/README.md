# BJS Home Delivery

BJS Home Delivery is a British two-man home delivery service for large items that high-street
retailers sell. Tracked through the lookup its mini tracker makes.

## How it works

1. `direct`: one `GET https://api.bjshomedelivery.com/v1/website/mini_track?OrderReference={number}`,
   with the number printed with its dash, as the tracker's `/mini-track` page sends it. The
   page also sends the number in an `OrderReference` header and a `Key` header whose value its
   script gives every visitor, and the adapter does the same. It needs no cookie, session or
   browser. The JSON reply lists the reference's consignments, each with its status and a day.
2. `retry`: one more try after a failure to reach BJS or a read that hangs.

- An unknown reference is HTTP 400 with `"Bad request. 'Orders' not found"`, which the page
  reports as not found. Another `success: false` reply is inconclusive.
- A request without the key gets HTTP 401 `"Unauthorised. Invalid 'Key'"`, which the adapter
  reports as a challenge.
- The reply also lists an order's other consignments. Only the row whose `consignment` is the
  whole number asked counts; the number the reply echoes back is not read.
- Recognition makes the same request. Any row for the consignment is an order BJS holds.

## Notes

- The main tracker asks for the recipient's email, postcode or phone number, and an hCaptcha,
  before it shows the delivery history, the booked slot and the crew's position. The adapter
  reads only what the mini tracker shows anyone: the current status and its day.
- The day is a UK calendar day without a time, kept as the status's `local_time` when it is not
  after the lookup's date in the UK. The page labels it "Timestamp" and does not say what a
  later day is, so a later day is not kept and there is no expected delivery.
- The result is a summary, not a history.

## Limitations

- No scan history, depot, delivery slot or estimate.
- The status wordings come from the tracker's progress bar and page script, and their sources
  are in [`statuses.json`](statuses.json).

## Numbers

A consignment number is `B`, seven digits, a dash and four digits. Thousands of archived
lookups on BJS's tracker use this layout. Detection reads it without the dash, as `B` and
eleven digits. `bjs-home-delivery-1` suggests BJS for that shape with low confidence, because
numbers of the same shape also come from outside BJS's network, and Colis Privé's generic
twelve-character rule accepts it too. Recognition asks BJS, so a number it holds goes to the
adapter. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker reads the number from its `parcel-id`, `OrderReference` or `order-number`
parameter, so `track.bjshomedelivery.com/?parcel-id={number}` opens one consignment. Older
links pass `parcel-id` to the company's home page. The page's script runs only once the visitor
accepts statistics cookies.

## Testing

`npm run test:carriers:live -- carriers/bjs-home-delivery`, with
`BJS_HOME_DELIVERY_TRACKING_NUMBER` and optionally `BJS_HOME_DELIVERY_UNKNOWN_NUMBER` set
outside the repository.
