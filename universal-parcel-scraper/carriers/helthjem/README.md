# Helthjem

Tracks parcels of Helthjem, the Norwegian home-delivery network, through the GraphQL service its
tracking page asks.

## How it works

`helthjem.no/sporing/{number}` asks `POST https://services.helthjem.no/graphql` for the parcel,
without an account, key, cookie or token. The page loads reCAPTCHA, but its tracking query sends
no token. The adapter sends one query, which asks only for the parcel's numbers, state and scans,
the shop's name and the pickup point's name; a request that fails to reach Helthjem is sent once
more within the budget.

The reply must name the requested number as the parcel's SSCC or shipment number. A home delivery
sent on to a pickup point is relabelled, and the reply then names the new label; it is read when it
echoes the requested number as the parcel's reference and shows the parcel on its way to a pickup
point, by a state or a scan's wording. The new label, its SSCC or else its shipment number, is the
`canonical_tracking_number`. A number the service does not know, or no longer keeps,
comes back as a null parcel, so it is not found. A query the service rejects is a schema change.
Block pages, HTTP errors, GraphQL errors outside the parcel and malformed replies keep their own
failure kinds. Recognition uses the same lookup.

## Numbers

The search takes an SSCC, with or without the `00` of its GS1 identifier, and the parcel's
seventeen-digit shipment number, with or without `401` in front, and the reply answers to each
form. The adapter checks the GS1 check digit and takes nothing else without a request. The page's
short codes, one character, a dash and five letters or digits, are not taken.

Helthjem issues SSCCs under its own GS1 company prefix, `7072476`: archived lookups of several
shops' parcels share one serial sequence, and Helthjem's tracker answers for them. `helthjem-1` and
`helthjem-2` therefore select Helthjem for SSCCs under that prefix, though Bring's broader rule for
Norwegian SSCCs also fits them.
An SSCC under another prefix, such as a shop's own, names whoever issued it, so no rule offers
Helthjem for it, and nor does a rule cover the shipment number.

## Notes

The parcel and each scan carry one of the service's states, and each scan an event code, a clock
with its offset and Norwegian wording. The adapter stages the parcel and each scan by its state and
keeps state and code as `IN_TRANSIT/003`. Code 113 books the parcel on a night round the day
before it. Helthjem files it as delivering, but no courier has the parcel yet, so the adapter stages
it `in_transit`; its wording names the night, and the day that night ends on is the expected
delivery while no scan but a terminal's has followed the booking. Code 057, filed as delivering
too, says the night's courier did not take the parcel out, so it is `in_transit` as well. The
parcel's state takes the stage of its newest scan in that state. The page hides the scans of its
sorter, which it names `VestbySorter`; the adapter keeps them. A delivery is often scanned twice,
seconds apart, and the first scan of the latest run is the delivery time.

The shop is the sender. The pickup point is named only while a parcel waits there or once it was
collected. A parcel the page sends to PostNord's tracker keeps its shipment number as the
delivery tracking number. Recipient and sender postcodes, the pickup point's address, phone and
opening hours, scan help texts and proof-of-delivery images are not requested.

## Limitations

The service keeps a parcel for a few months: older numbers come back as null, like unknown ones.
The reply's delivery estimate is not read, since its date was empty on every live reply. The page
words a returned parcel like one on its way back.

## Links

Helthjem's search form opens the result at `helthjem.no/sporing/{number}`. Older links from its
own site carry the number in the `sporingsnummer` parameter of `/sporing`. The library reads
both.

## Live test

Set `HELTHJEM_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/helthjem/adapter.live.test.ts`.
Optionally set `HELTHJEM_UNKNOWN_NUMBER` to check a number the service does not know.
