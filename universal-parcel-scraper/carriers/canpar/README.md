# Canpar

Tracks individual parcels through the official anonymous tracker: by barcode,
pickup tag (P), return label (R) or delivery notice (W).

## How it works

One bounded JSON POST requests parcel history without expanding the shipment,
in the request Canpar's page makes for the number:

- A barcode or a tag is asked as a barcode, and the answer must carry it.
- A delivery notice has its own lookup, which lists the parcels it was left for.
  One parcel's history is kept with its barcode as `canonical_tracking_number`;
  several end inconclusive with the reason `several_parcels`.
- A short barcode, 8 to 20 digits after its letter, is asked with the optional
  destination postal code, sent in capitals without spaces, else as a barcode.
  Canpar may answer with the whole barcode, the sender's eight-digit shipper
  number after the letter, kept as `canonical_tracking_number`. When Canpar
  needs the shipper number, the lookup asks for the postal code (`input_required`).

Empty placeholder packages and provider errors remain inconclusive. An empty
result or placeholder carries the reason `portal_not_found`, so a consumer can
tell Canpar's answer from an outage; a provider error has no reason. Canpar
answers an unknown notice, or a short barcode with a postal code it does not
match, with such an error.

## Notes

Scans retain the provider's newest-first order and local clocks. The public
client ignores the ambiguous clock-shift field; no instant or delivery timestamp
is inferred from it. The host retains those scans and asks providers for dated
progress. Each scan uses its own code. A completed return does not override later
movement or delivery. The service, such as `GROUND`, is kept in English as
`service_name`. The expected delivery day is kept while the parcel is on its way and
dropped once a newer day's scan arrives or the parcel is delivered or returned.
References, full addresses, comments, contacts, signatures and proof images are
excluded.

Detection offers Canpar for full barcodes only; the other forms are tracked
when Canpar is chosen. Reference searches need the shipper number or a postal
code with the reference and are outside this adapter's scope.

## Live test

Set `CANPAR_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/canpar/adapter.live.test.ts`.
Optionally set `CANPAR_UNKNOWN_NUMBER` to check an inconclusive empty result.
