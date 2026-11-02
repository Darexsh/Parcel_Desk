# CACESA

CACESA, a Madrid customs agent, clears cross-border e-commerce parcels into Spain and Portugal
and hands them to the carrier that delivers them; it delivers none itself. Tracked through the
service its tracking page's search box calls.

## How it works

1. `direct`: one `POST https://apiweb.cacesa.com/cacesa.api/api/Tracking` with the JSON body
   `{"trackingId": "<number>", "ipAddress": ""}`. The tracking page asks this service; it needs
   no cookie, key, account or browser. The page also sends the visitor's IP address, which the
   service requires as a field but accepts empty, so the adapter sends none.
2. `retry`: one more try when the request fails to reach CACESA or hangs. The first try gets
   half of the budget.

- The service reads a comma or a space as a second number, so only letters and digits are sent.
  It checks no format, and an empty number makes it hang.
- The reply has one row per milestone, oldest first, each naming its shipment. Rows of another
  shipment are not read; a reply with none of the requested one is inconclusive.
- An unknown number gets one row worded "Envio no encontrado" with a year-one date, the row the
  tracker itself checks for: `NotFoundError`. A redirect and an empty reply are inconclusive.

## Notes

- Each milestone has a type (`EVENTO`, `ENTREGADO`, `INCIDENCIA` or `ERROR`) and an icon. The
  provider code joins them, as in `EVENTO/ico_aduana`. `ENTREGADO` is delivered whatever its icon.
  The event icons replies showed have their own stage, a document uploaded for customs included,
  and so do the incidents in which customs holds the parcel for inspection or to check its
  documents. Errors and other icons are left to the shared wording rules. The page's stylesheet
  names icons for delivery, pickup points, absent recipients and taxes, but no reply showed one.
- Wording is English, from the reply's English field.
- Clocks are Madrid wall time without an offset, and the adapter reads them in `Europe/Madrid`:
  the customs milestones match Cainiao's to the second under Madrid's offset.
- The page names no delivery carrier ("check with transport company"). The parcel goes on under
  the same number, so the result gives it as the delivery tracking number, and the hand-off asks
  a carrier whose high-confidence rule claims it: Ecoscooting for Cainiao's `CNESP` and `CNPRT`
  numbers.
- Universal providers name it "CACESA Logistics" (ParcelsApp) or "Cacesa Postal" (17TRACK).
  Detection has no rules for it, since it tracks the numbers of the platforms and carriers it
  works for.

## Links

The tracker at `cacesa.com/en/tracking` (`/es/seguimiento` in Spanish) reads the number from
`?busqueda=`, fills it in and looks it up. The server takes about twenty seconds to answer an
address with a number; the page without one answers at once.

## Limitations

- No location, delivery estimate, weight, sender or recipient.
- Older parcels drop out of the tracker and answer as unknown.

## Testing

`CACESA_TRACKING_NUMBER=... CACESA_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/cacesa`
