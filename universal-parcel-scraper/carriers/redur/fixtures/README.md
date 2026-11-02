# Fixtures

The pages follow the result Redur's tracking page renders after its search form's lookup, cut
down to the search form, the result block echoing the number, the progress rail, the scans
oldest first with their depot and package count, and the contact form's Turnstile widget.

- `delivered.html` is a shipment delivered, with the rail on its last step, a scan repeated in
  the same minute, a scan dated to the day alone and a collection scan after the delivery.
- `international.html` is a shipment of several packages handed to a partner abroad, whose
  scans give the partner's code or `Internacional` as their place, ending on a failed attempt.
- `not-found.html` is the tracker's answer to a number it does not know: the result block marked
  as an error, with an empty rail and no scans.

Numbers, places, clocks and keys are invented.
