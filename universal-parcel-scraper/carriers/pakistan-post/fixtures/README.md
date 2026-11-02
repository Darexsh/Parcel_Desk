# Fixtures

The pages follow the tracker's page for one number: a summary naming the item and the countries
or offices at each end, then its scans oldest first under the day they happened.

- `delivered.html` is an item sent abroad and delivered, with the IPS events the destination post
  sent back, one flight departure listed twice, a customs hold and release at the same minute and
  an update after the delivery.
- `in-transit.html` is an item from abroad held by customs at Pakistan's office of exchange.
- `domestic.html` is a registered letter delivered after a failed attempt, a missent bag and a
  second attempt whose reason is free text. The page names the bags, the person who took the
  item and phone numbers.
- `cod.html` is a cash-on-delivery item, followed by the money order that takes its amount back to
  the sender under its own number and history.
- `not-found.html` is the tracker's answer for a domestic number it holds no scans for.

Numbers, names, offices, flights, bags and clocks are invented.
