# SEKO Logistics

SEKO Logistics is a forwarder and freight carrier headquartered near Chicago. Its North
American network picks up, moves and delivers freight and large parcels, and its forwarding
arm books air and ocean shipments. Tracked through the lookup its tracking page makes. SEKO's
eCommerce parcels on its OmniParcel platform are not in that lookup and use enabled universal
providers.

## How it works

1. `direct`: one `GET https://mysekoapi.sekologistics.io/tracking-service/track/{number}`, as
   SEKO's tracking page on `sekologistics.com` makes it. It needs no cookie, token, key or
   browser; the page loads reCAPTCHA, but the lookup sends no token. The JSON reply has the
   shipment's summary and its milestones.
2. `retry`: one more request when the first fails to reach the service or hangs. The first
   gets half of the budget.

- An unknown number is an HTTP 404 without a body. A 404 with the gateway's own JSON, a 410 or
  a redirect is a moved route.
- Cloudflare sits in front of the service; its browser check is reported as a challenge.
- The shipment must echo the number asked.
- Recognition makes the same request.

## Notes

- A milestone's `eventDate` is SEKO's wall clock to the minute, with no zone. The delivery's
  milestone runs one or two hours off the proof of delivery's clock at the address, so the
  clocks are not the scanning place's either, and they stay `local_time`.
- Most milestones say `Status Changed to [X]`, naming one of the statuses the summary's
  `shipmentStatus` takes. The summary decides a delivery or a hold; otherwise the further of
  the summary and the newest staged milestone is the current stage.
- The history repeats some status changes within a minute, sometimes in another case; the
  copies are merged. Proof-of-delivery filing rows and a booked return move nothing and are
  dropped or left without a stage.
- `dueDate` is the expected delivery day. The weight is converted from pounds when the reply
  gives them.
- The reply's origin and destination addresses, postcodes, customer references, piece count,
  proof-of-delivery time and signer are not kept. The milestones name no location.
- The tracker also answers booking references and short partial inputs with the shipments
  that match them, so the adapter sends only whole numbers of eight to twenty letters and
  digits with a run of seven digits.

## Limitations

- OmniParcel numbers are not tracked here. `track.omniparcel.com` answers anonymously, but no
  current public sample could check it.
- The reply names no last-mile partner and no hand-off number.

## Numbers

SEKO's eCommerce parcels run through its OmniParcel platform. Its API guide and sample
tracking file give consignment numbers of three letters and seven digits, and package barcodes
that add a two-digit package counter. A Trustpilot review gives a shipping number of the same
consignment layout, which SEKO's tracker answers, and lookups archived from SEKO's tracker show
five letters and seven digits, and nine digits. OmniParcel also carries postal S10 numbers,
which belong to the postal network that issued them.

Australia Post, Day & Ross and DSV share the consignment layout, Colis Privé's numbers the
five-letter one and many carriers nine digits, and Purolator's rule claims the package
barcode's, so no rule claims SEKO numbers and recognition does not ask SEKO. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

SEKO's tracking page reads one number or several from `?trackingNumbers=` on
`sekologistics.com/en/track/`. The OmniParcel tracker on `track.omniparcel.com` opens a
number from `?id=`, from its path, or from a path that puts a numeric site prefix and a hyphen
before it.

## Testing

`npm run test:carriers:live -- carriers/seko`, with `SEKO_TRACKING_NUMBER` and optionally
`SEKO_UNKNOWN_NUMBER` set outside the repository.
