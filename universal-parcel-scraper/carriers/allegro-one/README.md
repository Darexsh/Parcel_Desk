# Allegro One

Allegro's own delivery network in Poland, with One Box lockers, One Punkt pickup points and One
Kurier couriers, and Allegro Delivery, the service under which partner networks such as DPD,
DHL eCommerce and ORLEN Paczka carry parcels for Allegro under Allegro's own number. Tracked
through the service Allegro's tracking page asks on Allegro's edge gateway.

## How it works

1. `direct`: one `GET https://edge.allegro.pl/ad/tracking?packageNo={number}` with
   `Accept: application/vnd.allegro.internal.v1+json` and `Accept-Language: pl-PL` for a lookup
   whose `language` is Polish, `en-US` for any other. The Allegro Delivery tracking page, which
   the links open, asks this service; it needs no cookies, key, account or browser. The reply lists the parcel's scans, each a UTC instant and a wording: an
   older parcel's newest first, a newer one's oldest first.
2. `retry`: one more try when the request fails to reach Allegro or hangs. The first try gets
   half of the budget.

- The reply does not echo the number: the scans are those of the number in the request.
- An empty or null list is what the tracker shows as not found. Every fresh A0 and AD number
  seen lists scans from its label on, so an empty list for them is `NotFoundError`. Older
  Allegro Delivery parcels drop out of the service, so an old AD number reads as not found too.
  For the older ALE form an empty list is `NoHistoryError`.
- A courier's collection, such as "Parcel has been picked up from point by courier", is the
  sender's drop-off collected until the parcel has waited at a point for its recipient. After
  that it is the uncollected parcel taken back, staged by where the later scans say it went: a
  return to the sender makes it `exception`, a return under way, and a new delivery to a point
  or the door `in_transit`. Until a scan says, it is `exception` once the pick-up time has
  expired, since Allegro then sends the parcel back, and `in_transit` before that.
- "Parcel has been returned to the sender" sends the parcel back. It is `returned` when no later
  scan moves the parcel, and otherwise `exception`, a return under way. The later scans are its
  way back and stay `exception` until a delivery, the sender's, makes it `returned`.
- A refused request (HTTP 400 or 406), the gateway's "Feature unavailable" 404 for a retired
  route, a redirect, a bot check and malformed replies keep their own kinds; none is not found.
- Recognition makes the same request. `allegro-one-1` and `allegro-one-2` claim these numbers
  at high confidence, so preflight does not ask it.

## Notes

- `allegro.pl` sits behind DataDome, which blocks automated browsers and plain HTTP clients
  alike. The edge gateway does not.
- The gateway answers only Allegro's own media type; another `Accept` gets HTTP 406.
- The service words scans in English for `en-US` and in Polish for `pl-PL`, a bare `en` or `*`,
  which Node's fetch sends by default. Instants and their order are the same in both.
- The service sends no status code, so the map stages each wording: the English one, and each
  Polish one by the English the service gives the same scan. A scan the map does not know is left
  to the shared wording rules. A scan stored in one language takes the other's wording in place:
  at its instant, a wording that translates the stored one identifies it.
- The older Allegro One page asked `/one/tracking`, which answers the same numbers but leaves out
  a newer parcel's sorting-centre scans, so it is not used.
- Allegro Delivery's partner scans come through the same service, in the same wording.

## Numbers

Allegro One numbers are ten letters and digits starting `A0`. Allegro Delivery numbers start
`AD` and have seventeen characters: `AD0` and fourteen digits and consonants. Earlier Allegro
Delivery numbers, and some returns, have ten characters like Allegro One's. `allegro-one-1`
claims `A0` or `AD` followed by eight letters and digits, `allegro-one-2` the seventeen-character
form. The adapter takes `AD` and any fifteen letters and digits. Allegro's courier pickup orders,
`AD` and twelve digits, are not parcels. The tracker also answers an older form, `ALE` and twelve
digits, which the adapter takes but detection does not offer. Allegro publishes no check digit.

## Links

`allegro.pl/allegrodelivery/sledzenie-paczki?numer={number}` and the older
`allegro.pl/kampania/one/kurier/sledzenie-paczki?numer={number}` open the tracker with the number.
These links name Allegro One only for a number its detection rules claim (`ownNumbersOnly`). Any
other number they hold, the `ALE` form included, is detected on its own.

## Limitations

- No location, pickup point, delivery estimate, weight, service, sender or recipient.
- The reply names neither the partner carrying an Allegro Delivery parcel nor that partner's
  number.

## Testing

`ALLEGRO_ONE_TRACKING_NUMBER=... ALLEGRO_ONE_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/allegro-one`
