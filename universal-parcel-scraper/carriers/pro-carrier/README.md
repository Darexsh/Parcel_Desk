# Pro Carrier

Pro Carrier, formerly DG, is a UK freight and cross-border e-commerce delivery business. Its
tracker shows each parcel under Pro Carrier's number together with the partner carrier that
moves or delivers it, such as Royal Mail, InPost or Colis Privé, and links to that partner's
tracker. Tracked through the tracker's own page.

## How it works

1. `direct`: one `GET https://tracking.weareprocarrier.com/?tn={number}`. It needs no cookie,
   token, key or browser. The server renders the parcel's details and its history, newest
   first.
2. `retry`: one more attempt after a failure to reach the tracker, inside the budget.

- An unknown number is HTTP 200 with the search form and the notice
  `Shipment not found ({number})`, which must repeat the number asked. A 404 or a redirect is
  a moved route.
- Cloudflare answers some networks with its managed challenge, HTTP 403 and
  `Just a moment...`, which the adapter reports as a challenge. Other networks get the page
  with plain HTTP. Every page carries Cloudflare's script beacon, which is not a check.
- The parcel's details must echo the number asked.
- Recognition makes the same request.

After an identified browser challenge, `trawl` opens the same tracking address in the
configured browser service. The carrier parser checks the whole shipment identity.
Definite answers, rate limits and malformed replies do not launch a browser.
Recognition stays HTTP-only.

## Notes

- Scan clocks are wall clocks to the second with no zone, from the UK and from the destination
  country, so they stay `local_time` and the page's order stands.
- Event names are the tracker's own lower-case vocabulary for Pro Carrier's scans and the
  partners' scans it relays, mapped in [`statuses.json`](statuses.json). On a return from the
  US, USPS's delivery to Pro Carrier's returns address arrives as "arrived at processing
  centre", which stays in transit. Email notices to the recipient have no stage.
- Each scan's comments are not read: they repeat the event name or carry the partner's free
  text, which can name who took the parcel.
- The partner button's host and path name the delivering carrier; its query is never read,
  because Colis Privé's carries the recipient's postcode. InPost's UK tracker is mapped here.
  The Carrier Tracking Number becomes `delivery_tracking_number`. Colis Privé's tracker needs
  the postcode as well, so its parcels get no automatic hand-off, and a longer Colis Privé
  value is not kept.
- The service code and weight are kept. Of the destination, only the country is kept.

## Limitations

- No per-scan place, no delivery time as an instant and no estimate.
- The tracker also answers the labels of the partners a parcel travels with; the adapter takes
  Pro Carrier's own numbers only.

## Numbers

Lookups archived from its tracker show `DG` and eleven digits from the DG years, which
`pro-carrier-1` suggests. Two characters and eleven digits is also La Poste's family, and its
low-confidence rule takes them too, so neither rule names a carrier alone. A recent parcel uses
`UBG` and nine digits, the layout of Purolator's rule; one sample does not establish the
family, so no rule claims it, though the adapter accepts it. The tracker also answers for the
labels of the carriers a parcel travels with: Royal Mail labels for domestic parcels, `JJD`
labels, USPS labels on returns from the US and Fast Despatch Logistics numbers. Those stay with
their own carriers' rules. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker at `tracking.weareprocarrier.com` reads the number from `tn`, so
`tracking.weareprocarrier.com/?tn={number}` opens one parcel. An integration guide prints the
address with a doubled slash before the query, which opens the same page. A link names Pro
Carrier for whatever number it carries, so a partner's label in it fails the adapter's number
check and falls to enabled universal providers.

## Testing

`npm run test:carriers:live -- carriers/pro-carrier`, with `PRO_CARRIER_TRACKING_NUMBER` and
optionally `PRO_CARRIER_UNKNOWN_NUMBER` set outside the repository.
