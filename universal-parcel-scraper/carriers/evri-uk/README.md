# Evri UK

Domestic UK parcel history. Evri International stays under
[evri](../evri/README.md). A barcode's shape alone does not establish which
service owns it; select Evri UK explicitly or use its official tracking link.
Detection offers both services only when the barcode's last digit matches: a
letter counts as its ASCII code minus 63, mod 10, and the first fifteen
characters weigh 2, 1 from the left, summed mod 10. Archived barcodes with `A`
or `D` in the sixth place are Evri UK's and those with `C` Evri International's,
with one exception, so detection lists that service first without choosing it.
Barcodes opening `C00HHA`
appear only on Evri UK's own tracking links, so detection offers them to Evri
UK alone. Recognition asks both services about lettered barcodes, and a barcode
both know is left for the reader to choose.

## Retrieval

`direct` uses the guest tracking API of the official
[Android consumer app](https://play.google.com/store/apps/details?id=com.hermes.hercules)
over plain HTTP. `GET tracking.platform-apis.evri.com/v1/parcels/reference/{barcode}`
resolves the barcode to a parcel URN, and `GET /v1/parcels/?uniqueIds={urn}`
returns its history. Both carry the app's guest key in the `apiKey` header,
without an account, postcode or WAF token.

The app receives that key from Firebase Remote Config, under
`enterprise_tracking_api_key_android_string`. It is the same for every install
and is included in the adapter.

`browser` uses a fresh local Chromium through `TRACKING_CHROMIUM_PATH` when the
guest API is refused or unreachable. The official page's AWS WAF SDK obtains its
token and rotating API keys from `/protected/keys.json`. The customer search at
`api.evri.com/customer-tracking/v1/search/{barcode}` supplies parcel
identifiers, the application constructs a lookup-day URN and reads the same
history service. Those keys and tokens remain inside the browser.

The page reads the same history as the guest API. When the guest API answers
without confirming a parcel, the page is not opened.

Recognition sends the guest API's reference lookup alone and never opens the
page. A barcode it resolves is known. No parcel, a barcode the service rejects
for its last digit, and a parcel it redirects to Evri International are
unknown; several parcels under one barcode stay inconclusive. An all-digit
barcode is suggested and asked about only when its last digit is its GS1 check
digit, as on every archived one; other carriers' sixteen digits pass the same
check, so it is never chosen.

The browser's automation flag and installed-version User-Agent are configured
for this carrier because the protected key request rejects the default
automated launch. The context is closed after each lookup and shares the
caller's deadline and cancellation signal.

## Notes

- The reference or search must identify one Evri parcel with the requested
  barcode. International redirects are inconclusive and are never followed.
- A reference the guest API rejects or does not know is inconclusive. Evri
  drops old parcels, so an empty answer does not establish that none existed.
- Both the history barcode and URN must match. Progress rails and estimates
  do not become scans; only dated tracking events establish activity.
- The event's rail code sets its stage. A few tracking points refine it: a
  drop-off or collection is the acceptance, a failed courier visit is a
  failed attempt, and a customer return's processing and journey back are
  returned. Unknown rail codes remain unstaged. A scan's `provider_code` keeps
  its rail and its tracking point, as `rail/point` (`4_SHOP/ARRIVED_PARCELSHOP`).
  The app's review (`statusMap`) stages a scan by that code as the adapter does
  and leaves a scan on an unknown rail open. A scan stored with its tracking
  point alone, or without a code, is staged only by the `Delivered` wording.
  The code is not part of a stored scan's identity, which the app keys on its
  time, place and wording.
- A parcel sent to a ParcelShop or locker waits on the `4_SHOP` or
  `4_LOCKER` rail, which evri.com's tracking page reads as awaiting
  collection, so it is ready for pickup until the `5_SHOP` collection, which
  is its delivery. Points on these rails do not refine them: a ParcelShop
  arrival there is the parcel reaching its recipient's shop, not a drop-off.
- On the delivery day a courier scan carries the window it announces. The
  newest scan's window becomes `expected_delivery` on the British clock; a
  later scan replaces or withdraws it. A delivery's time is `delivered_at`.
- `sender_name` is the account Evri names as the sender, only when Evri
  marks the parcel as neither consumer-to-consumer nor a customer return.
- `service_name` is the delivery service Evri gives the parcel
  (`service.serviceType`), such as next-day or two-day delivery.
- Unresolved clocks stay in `provider_time_text`; sorting requires every
  event clock to resolve.
- Recipient, address, photos, GPS, ownership credentials and delivery prose
  naming a person or safe place are discarded.

## Limitations

Calling-card numbers, postcode-gated ownership details, locations and the
ParcelShop holding a parcel are not projected. Evri announces no estimate
before the delivery day. No TRAWL path is registered. A refused key, WAF rejection or
empty history does not establish parcel absence. The adapter does not fetch a
rotated key from Remote Config. The deployed browser's network and build still
affect the page step.

The current official flow was compared with the
[MIT parcelcli implementation](https://github.com/cavit99/parcelcli/tree/48bdc78497da3dd5d5fd82aefe8a0f8a99b44650/internal/carriers/evri).
This adapter validates structured identity and history rather than rendered
text markers.

## Testing

Set `EVRI_UK_TRACKING_NUMBER` outside the repository, then run
`npm run test:carriers:live -- carriers/evri-uk`. With `TRACKING_CHROMIUM_PATH`
set, the page step is compared with the guest API on the same parcel.
