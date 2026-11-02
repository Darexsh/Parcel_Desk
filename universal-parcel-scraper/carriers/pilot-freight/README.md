# Pilot Freight Services

Pilot Freight Services moves heavy and bulky freight across the United States, often to the
buyer's home, and books air and ocean freight abroad. Maersk owns Pilot. Its network now trades
as Maersk Ground Freight, and its tracker on `delivers.maersk.com` still reads Pilot's own
tracking service. Tracked through the lookup that tracker makes.

## How it works

1. `direct`: one `GET https://wwwapi.pilotdelivers.com/track/{pro}/orgzip/0/dstzip/0/custnum/0`,
   with the pro number in base64, as the tracker at `delivers.maersk.com/tracking/{pro}` makes
   it. It needs no cookie, token, key or browser. The JSON reply holds one shipment, its parties
   and its history, newest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A pro number the service has no shipment under is HTTP 200 with an empty shipment and the
  error `ERROR_102` (`NO TRACKING INFO FOUND`). An empty shipment without that error, or one for
  another pro number, is inconclusive. A 404 or a redirect is a moved route.
- The service also answers numbers shorter than a pro number with some shipment, so the
  adapter sends whole nine-digit pro numbers only and keeps a reply only when it names the
  number asked.
- The tracker's delivery scheduling form reads another endpoint, which returns the consignee's
  contact details. The adapter does not use it.
- Recognition makes the same request.

## Notes

- Every clock carries Eastern time's offset, whatever it records: events entered in Eastern
  time, a delivery written in the consignee's local time, an appointment's local hours. The
  offset is kept only where it is the one the place's zone keeps at that instant, in a state
  that keeps one zone throughout. Elsewhere, and for events recorded by phone or online, which
  name no place, the clock stays a wall clock in `local_time`.
- The year 0001 marks a clock the service does not have.
- Descriptions are capitalized word by word, as the tracker shows them.
- Appointments, pre-delivery calls and the messages that arrange them move nothing. A
  delivery settles the shipment whatever is recorded after it. A code the documentation files as
  an exception and the status table does not list is an exception.
- The reply gives an estimated delivery, which the tracker does not show. It is the estimate
  until the delivery, from the start of the appointment when the appointment ends then. Its
  clocks are read through the consignee's state like the events', and give days where the
  offset is not kept.
- The weight is the sum of the line items' pounds; the tracker shows the first line's.
- The reply masks the parties' names, addresses and phones but not their towns. It also holds
  references, the goods' description, dimensions and piece counts, who signed, where the freight
  was left, the proof of delivery's name and document link, the stations' contacts and the
  billing account. None of them is kept, and neither are the events' ZIP codes.

## Limitations

- No sender, recipient, signature or proof of delivery.
- Old shipments keep only part of their history.
- A pro number reaches the adapter when it is filed under Pilot or opened from a Pilot link:
  nine digits are shared by many carriers, so no rule claims them and preflight does not ask it.
- Pilot's documented partner tracking API on `pilotssl.com` needs a customer account.

## Numbers

A Pilot pro number is nine digits. Archived lookups on its former quick-track page show some;
the samples and their sources are in [`numbers.json`](numbers.json). The examples in Pilot's
tracking API documentation and one archived lookup are left out, because the tracker names who
signed for them.

## Links

Maersk's ground freight tracker opens one shipment at `delivers.maersk.com/tracking/` followed
by the pro number. Pilot's former `quicktrack.aspx` page read it from `?Pro=`; that address now
redirects to Maersk.

## Testing

`npm run test:carriers:live -- carriers/pilot-freight`, with `PILOT_FREIGHT_TRACKING_NUMBER` and
optionally `PILOT_FREIGHT_UNKNOWN_NUMBER` set outside the repository.
