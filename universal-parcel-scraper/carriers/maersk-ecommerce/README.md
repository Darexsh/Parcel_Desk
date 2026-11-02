# Maersk eCommerce

Maersk eCommerce is Maersk's parcel business, built on Visible SCM in the United States and B2C
Europe. It sorts parcels for online shops and marketplaces and hands each to a last-mile carrier.
Its numbers are `1M`, the client's seven-character code and ten digits. The adapter reads Maersk's
parcel tracker. Maersk's freight network is [Pilot Freight Services](../pilot-freight/README.md).

## How it works

1. `direct`: the parcel page at `www.maersk.com/tracking/parcel/{number}` asks `GET
   https://api.maersk.com/ecommerce/tracking/public/packages/{number}` with the consumer key the
   site gives every visitor, and the adapter sends the same request. It needs no cookie, session
   or browser.
2. `retry`: one more read when the first fails to connect or hangs. The first gets half of the
   budget.

- Only a reply whose `maerskTrackingNumber` is the whole number asked is read.
- An unknown number is a 404 with an empty body, read as not found. A 404 with a body, a refused
  key or a redirect is a moved route, and a reply that is not JSON is a schema failure.
- Recognition makes the same lookup.

## Notes

- Maersk relays the last-mile carrier's scans, coded from 77000, after its own. The map stages the
  codes recorded in [statuses.json](statuses.json); a code it does not know is an exception when
  Maersk flags it as one, else takes the group of the tracker's progress rail. The group alone
  never makes a delivery.
- A scan with an offset is an instant, checked against the reply's UTC clock. Some partners' scans,
  such as DPD's, state none and keep their wall clocks.
- The reply names the last-mile carrier and its number. When the catalog tracks that carrier in the
  destination country and its rule fits the number, they become `delivery_carrier` and
  `delivery_tracking_number`.
- The expected delivery is the day of the tracker's estimate, which names no zone. It is dropped
  once the parcel is delivered.
- The client's order number and code, the destination's town and postcode, and the partner's
  tracking link are not read.

## Limitations

- No sender, recipient, signature, weight or proof of delivery.
- The numbers Maersk gives Cainiao's parcels, `1MCAINIXX` and ten digits, are tracked under
  [AliExpress](../aliexpress/README.md): Cainiao's tracker holds the journey from China as well.

## Numbers

Archived parcel pages show numbers of three clients; the samples and their sources are in
[`numbers.json`](numbers.json). The client code varies, so `maersk-ecommerce-1` only offers the
number: recognition asks the tracker, which files the parcel when it knows it.

## Links

`www.maersk.com/tracking/parcel/` followed by the number opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/maersk-ecommerce`, with `MAERSK_ECOMMERCE_TRACKING_NUMBER`
and optionally `MAERSK_ECOMMERCE_UNKNOWN_NUMBER` set outside the repository.
