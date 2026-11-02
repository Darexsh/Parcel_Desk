# E-Commerce International

E-Commerce International (E-com International) is a Polish forwarder that takes online shops'
parcels from its warehouse in Warsaw to its warehouse in Kyiv and hands them to a Ukrainian
courier, usually Nova Poshta or Ukrposhta, which delivers them under its own number. Tracked
through its tracking page.

## How it works

1. `direct`: one `GET https://ecommerce-system.com/track/{number}/__data.json`, the data the
   tracking page loads. It needs no cookie, token, key or browser.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- A number the tracker does not know fails the page's load with HTTP status 404 and
  `Parcel not found` inside a 200 reply, read as not found. Any other failed load leaves the
  answer open.
- A redirect or a 404 reply is a moved route, and a firewall page or a 403 is a challenge.
- The reply echoes the parcel number; a reply for another number leaves the answer open.
- Recognition makes the same request.

## Notes

- Each status is a nine-digit code and an instant in milliseconds. The page shows the code's
  text from its locale files; the adapter keeps the English text, with the code as the provider
  code. A code it has no text for keeps its code as its text.
- Codes for cash on delivery, fees and notes name no step of the parcel, so they give no stage.
- The page's Polish "zwrot" is both a return and a refund, so English texts that read "refund
  received" are returns.
- The courier the page links to for its service becomes the delivery carrier, with the courier's
  number beside it.
- The reply holds no names, addresses or places.

## Limitations

- No places, expected delivery or proof of delivery.
- A courier the page names but does not link to, and a service without the courier's number,
  name no delivery carrier.

## Numbers

A parcel number is PL, eleven digits and UA. Its API documentation and the public sample start
the digits with 15, so detection takes PL15 numbers only; the adapter takes any PL number of that
length.

## Links

A link to the tracking page with the number in its path opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/e-commerce-international`, with
`ECOMMERCE_INTERNATIONAL_TRACKING_NUMBER` and optionally `ECOMMERCE_INTERNATIONAL_UNKNOWN_NUMBER`
set outside the repository.
