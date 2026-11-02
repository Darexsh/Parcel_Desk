# Norsk Global

Norsk Global is a British international express and e-commerce shipping company. It takes
parcels from UK senders abroad and hands them to a partner carrier, such as USPS or Landmark
Global, for delivery. Tracked through the lookup its tracker makes.

## How it works

1. `direct`: one `POST https://portal.norsk-global.com/api/public/{token}/tracking` with the
   body `{"reference":"{number}","userToken":[]}`, as the tracker sends it. The token is the
   client token of Norsk's own site on the tracker, which the tracking page gives every visitor
   and the adapter ships. The JSON reply is an array of the shipments that carry the reference.

- An unknown reference is HTTP 200 with `[]`. A 404 or a redirect is a moved route.
- A refused token is HTTP 401. The adapter then reads the current token from the tracking
  page's server components (`GET https://norsk.trackmyparcel.info/gb` with `RSC: 1`), asks
  once more and keeps the new token. A page without the token of the `norsk` site, or a token
  refused again, is a changed tracker.
- The tracking page's server sends its certificate without its intermediate, Go Daddy Secure
  Certificate Authority - G2. Over the global fetch the adapter reads the page trusting the
  intermediate in [certificate.ts](certificate.ts); a host's own fetcher is used as given. The
  lookup's server sends the whole chain.
- The shipment's own `hawb` must be the reference asked.
- Recognition makes the same request.

## Notes

- The tracker is a white-label platform: merchants and partners have their own sites on
  `trackmyparcel.info`, each with its own token. The adapter asks Norsk's own site. No other
  carrier in the catalog uses the platform.
- The tracker also finds a shipment by its partner's number or a sender's reference. Those are
  not Norsk's references, so such an answer is inconclusive. Only whole references of ten or
  more characters are sent.
- A scan's `timeStamp` with an offset is an instant. One without is the scanning site's wall
  clock, which can be a partner's abroad, so it stays `local_time`.
- A message loses the copy of its clock it starts with, as the page drops it, any sentence with
  an e-mail address and phone numbers. A delivery loses the clause naming who signed for it.
  The recipient's name and postcode and the proof of delivery's signatory and time are not
  read.
- The shipment's `statusDescription` of `POD` is a delivery, as is a summary worded as a
  delivery or a return. Otherwise the newest staged scan gives the stage, read by the shared
  wording rules. The older tracker wrote each scan as `Status changed to:` and the status.
- `agentName` names the partner, read as the page's own partner links read it, and
  `trackingNumber` is its number, without the ZIP code a USPS routing barcode opens with. They
  become `delivery_carrier` and `delivery_tracking_number`.

## Limitations

- The reply's fields come from the tracker's own code and its scan wording from archived
  lookups. No public reference has a live history to check the clocks and wording against.
- No expected delivery, weight or service.
- Older references can have expired and look unknown.

## Numbers

Archived lookups on several merchants' sites on Norsk's tracker, and a customer's review that
Norsk answered, give `PKG` and twelve digits, from one counter across merchants. `PKG` is a
common prefix, so `norsk-global-pkg` only suggests Norsk and recognition asks it. A single
archived lookup gives `NOR`, four digits, a country code and eleven digits: the layout of
[FedEx International Connect](../fedex-international-connect/README.md)'s numbers, which Norsk's
tracker finds as a partner's number, so detection asks FIC first. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

Norsk's tracker opens one parcel at `norsk.trackmyparcel.info/gb/tracking/{number}`. Its
search form builds that address; older lookups leave out the language segment.

## Testing

`npm run test:carriers:live -- carriers/norsk-global`, with `NORSK_GLOBAL_TRACKING_NUMBER` and
optionally `NORSK_GLOBAL_UNKNOWN_NUMBER` set outside the repository.
