# Bookurier

Bookurier is a Bucharest courier. It delivers parcels under its own waybills and books others
with GLS Romania, DPD, Sameday and Cargus. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: `GET https://t.bookurier.ro/` opens a session (the `ci_session` cookie) and
   carries a lookup token in its `track-token` meta tag. Then
   `GET https://t.bookurier.ro/track/api?awb={number}&_token={token}` sends the token again in
   `X-Track-Token`, with the session cookie, as the page does. The reply is JSON under an HTML
   content type: the shipment's summary and its scans, newest first.

- A token serves one lookup, and each reply hands the page the next. Every lookup opens its
  own session.
- An unknown number is `success: false` with "AWB not found". A lookup without a valid session
  gets `token_expired`, with HTTP 200 or 403, which is inconclusive. HTTP 429 is a rate limit.
- The shipment must echo the number asked.
- There is no recognition: rule bookurier-1 claims BOK waybills with high confidence, so
  preflight never asks.

## Notes

- Scan clocks are wall clocks without an offset. Bookurier only delivers in Romania, so they
  are dated in Europe/Bucharest, a repeated hour as its first occurrence.
- A scan keeps the wording the page shows and, as its provider code, Bookurier's code for the
  group the page puts it in, such as `out_for_delivery`; the code stages it. "Repartizata",
  the order assigned to a courier, comes under `out_for_delivery`, but a partner's
  registration scan follows it hours later, so it stays registered. The summary's
  `is_delivered` and `is_returned` flags settle a delivery or a return.
- The masked recipient name, their town, the sender's name and the scans' `details`, which the
  page does not show, are not kept.
- Changing a delivery on the page needs the last four digits of the recipient's phone.
  Tracking does not, and the adapter never makes that request.
- A BOK reply names Bookurier as the courier and carries no partner number, so there is no
  hand-off. A shipment booked with a partner is filed under the partner's own number.

## Limitations

- No delivery estimate.
- The tracker also answers its partners' numbers. The adapter takes BOK waybills only; the
  others stay with their carriers and the universal providers.

## Numbers

Bookurier's own waybills are BOK followed by seven digits, seen in an archived lookup on its
tracker. Rule bookurier-1 claims them with high confidence: the tracker script assigns the BOK
prefix to Bookurier, and Australia Post's ten-character consignment rule only suggests the
shape.

Twelve-digit waybills from its tracker are kept as quarantined scope evidence because their
histories continue with GLS Romania scans and the tracker files them under GLS. Sameday and
DPD numbers are left to those carriers.

## Links

The current tracker opens one parcel from its `awb` parameter, and the older trackifnew.php
page on bookurier.ro took the same parameter. Both are read as links.

## Testing

`npm run test:carriers:live -- carriers/bookurier`, with `BOOKURIER_TRACKING_NUMBER` and
optionally `BOOKURIER_UNKNOWN_NUMBER` set outside the repository.
