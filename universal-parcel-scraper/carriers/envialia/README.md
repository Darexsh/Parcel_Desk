# Envialia

Tracks Envialia shipments in Spain through the guest search of Alina, the official app that
`www.envialia.com` links. Envialia is now part of Ontime, and the same service answers for
Ontime's own consignment notes in this shape, so Ontime's names count as Envialia's.

## How it works

The app's guest search is the SOAP 1.2 operation `buscarEstadoEnvio2` of the
`EnvialiaMobileService` web service on `app.ontime.es`. The adapter posts it once, as the app
does, with search type `T` (a tracking number) and the postcode and device id left empty. No
account, key, cookie, CAPTCHA or browser is needed.

A known number returns the shipment's agencies, its consignment note, a state code with its
Spanish wording, the shipping day and the network's target day. The reply is accepted when its
consignment note and one of its two agencies make up the requested number. An unknown number
gets an empty reply, which is the only missing shipment. A nil reply (a search the service could
not run), SOAP faults, Imperva block pages, rate limits and other HTTP errors keep their own
failure kinds. Recognition uses the same lookup.

## Numbers

A tracking number is the six-digit code of the agency in charge followed by the ten-digit
consignment note, as the app prints it, and the app searches only sixteen characters. Other
lengths are invalid without a request; a bare ten-digit consignment note cannot be searched
without its agency. Sixteen digits fit many other carriers and the agency codes are not
published, so no detection rule claims these numbers.

## Notes

- The answer is the current state only, marked `summary_only`, so enabled universal providers
  are still asked for scans. The service has no scan history for guests.
- State codes are mapped in [status.ts](status.ts) from the app's state table, an open-source
  client of Envialia's business web service and the old tracking page's progress steps.
  Rerouted, to be collected at the agency and partly delivered stay without a stage.
- The target day is kept as the expected delivery while the shipment is open. The app calls it
  the network's target day, and a delivery can come after it, so it is dropped once the
  shipment has ended or has a problem. The reply has no clock.
- The reply also names the destination postcode and town, the sender's reference, a shipment key
  and the delivering agency's name, phone, email and position. None is read. The app's detail
  operation, which adds the proof of delivery with the recipient's name, address and phone, is
  not called.

## Limitations

The old tracker at `www.envialia.com/seguimiento/` is gone. Ontime's guest web tracker and the
service's web operation need the destination postcode, so neither is used; on the tracker, an
unknown number and a wrong postcode get the same reply. Searches by sender reference are not
used. A state code the map does not know stays without a stage.

## Live test

Set `ENVIALIA_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/envialia/adapter.live.test.ts`.
Optionally set `ENVIALIA_UNKNOWN_NUMBER` to check a number Envialia does not know.
