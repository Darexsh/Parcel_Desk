# Chit Chats

Tracks Chit Chats shipments, from a seller's drop-off in Canada to the partner carrier that
delivers them, through the public tracking JSON Chit Chats documents for its tracking pages.

## How it works

Chit Chats' API documentation says a public tracking page gives its events as JSON when `.json`
is added to its address. The adapter reads `chitchats.com/tracking/<shipment ID>.json` with one
GET and does not follow redirects. It needs no account, key, cookie, CAPTCHA or browser. A
request that fails to reach Chit Chats is sent once more within the budget.

A known shipment answers with its package, service, estimate, partner carrier with its number,
and its scans newest first. The reply is accepted only when its shipment ID is the one asked
for. An unknown shipment ID is redirected to the search page, `/tracking`, with a session cookie
that carries a notice. The adapter reads that page once with the cookie; only the notice "Nothing
found for shipment ID" naming the whole ID is a missing shipment. A redirect elsewhere or without
a session, any other notice, HTTP 404 and a shipment without scans stay inconclusive. The web
server's 403 page and other block pages are challenges, and rate limits and other HTTP errors
keep their own failure kinds. A failure on the search page drops the request details, which hold
the session cookie. Recognition uses the same lookup.

## Numbers

A Chit Chats shipment ID is ten letters and digits, printed under the Chit Chats logo on its
labels. The adapter takes ten letters and digits with at least one of each; anything else is
invalid without a request. `chit-chats-1` offers the common shape at low confidence, so
recognition asks Chit Chats about it. Partner carriers' numbers stay with those carriers.

## Notes

- Chit Chats relays the partner's scans into its own history and labels them with Pacific time.
  Its own scans (the label, the drop-off, its facilities and the hand-over, "In transit") carry
  milliseconds and are kept as instants. Relayed scans can be hours off the partner's own clock,
  so they are kept as wall clocks without an offset, in the reply's order. A scan in Chit Chats'
  wording on a whole-second clock counts as relayed.
- Each scan has a status (`pre_transit`, `in_transit`, `out_for_delivery` or `delivered`) and the
  partner's wording. Delivery and out-for-delivery stage a scan outright. The other two also
  cover pickup notices and acceptance scans, so the wording decides first: Chit Chats' wordings
  and Canada Post's pickup notices are mapped in [status.ts](status.ts), others go to the shared
  wording rules, and the status stages only a scan neither knows. A confirmed delivery makes the
  shipment delivered.
- The partner and its number are given as `delivery_carrier` and `delivery_tracking_number`, so a
  consumer can follow the parcel with USPS or Canada Post. A USPS routing barcode opens with the
  recipient's ZIP code, which is dropped. A partner without an adapter keeps only its number.
- The estimate is the day of Chit Chats' end-of-day estimate, cleared once the parcel is
  delivered or returned. No delivery time is set apart, since the delivery is a relayed scan.
- Towns, postcodes, the recipient fields, the reply's token and the scans' subtitles, which repeat
  the partner's routing barcode, are never read. Postcodes are cut out of scan places, and a
  place still holding a digit is dropped as a possible street address.

## Limitations

A shipment Chit Chats no longer keeps reads as not found, because the search page gives it the
same notice. Relayed scans have no instant, so recognition dates a shipment by Chit Chats' own
latest scan.

## Links

The link opens the shipment's tracking page, `chitchats.com/tracking/<shipment ID>`. Pasted
links to it are read too.

## Live test

Set `CHIT_CHATS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/chit-chats/adapter.live.test.ts`.
Optionally set `CHIT_CHATS_UNKNOWN_NUMBER` to check a shipment ID Chit Chats does not know.
