# Atlantic International Express

Atlantic International Express is an international courier based in Mumbai, India. It collects
shipments through branches in India, flies them out and hands them to a partner abroad, whose
scans its tracker relays. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://atlanticcourier.net/action` with the body
   `{"function":"track","awbno":"{number}","searchby":"A"}`, sent with the form content type as
   the tracking page's script sends it. It needs no cookie, token, key or browser. The reply is
   an HTML fragment: a summary headed by the air waybill, a table with the consignee, the
   destination and the delivery, then the scans newest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A number without a shipment gets the notice `No Tracking Data Available. Please check your
  tracking number.`, which names no number. A 404, a 410 or a redirect is a moved route, and an
  empty reply is inconclusive.
- The adapter sends one whole air waybill and keeps the shipment only when the reply has one
  summary headed by that number. Another number, or several summaries, are inconclusive.

## Notes

- The reply says its scans are in local time for their location, and no clock names a zone. A
  scan whose place is in Atlantic's network in India, such as `MUMBAI`, `NEW DELHI` or `PUNE`, or
  a place ending in `INDIA`, is read on India's clock. `DELHI` and `HYDERABAD` alone stay wall
  clocks, as Canada and the United States have a Delhi and Pakistan a Hyderabad, and so do the
  partner's scans abroad and rows without a place.
- `SHIPMENT RECEIVED` is Atlantic's receipt at the branch that books the shipment, then again at
  each hub on the way. The oldest is the acceptance and the others are in transit.
- The summary's `Delivery Date`, such as `1st August 2026 , 1:18 PM`, settles the shipment as
  delivered. Before a scan delivers it, the delivery is the newest event, on a wall clock, since
  the summary names no place. A delivery at midnight is a day without its time.
- The consignee's name and the `Signing for` name are dropped, and removed from the scans along
  with a partner's `signed by` or `received by` clause.
- The summary shows the partner's forwarding number as `Fwd No`, without naming the partner. The
  relayed scans name it at most in passing, and the one seen, DPD, runs several national networks,
  so the forwarding number is not kept and there is no hand-off.

## Limitations

- No estimate, weight, service, origin, sender or proof of delivery. A partner's relayed
  `Estimated delivery` line stays a row without a stage.
- A number reaches the adapter when it is filed under Atlantic or opened from its link: no rule
  claims its numbers, so preflight does not ask it.

## Numbers

Atlantic air waybills are plain digit runs. Lookups archived from its former tracker show six
and seven digits; customers now quote ten. The tracking page says the number is numeric and its
length varies. The adapter sends runs of six to ten digits and nothing else. Such digit runs are
printed by many carriers, so no rule claims them. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The site builds `/track/<number>/` addresses on `atlanticcourier.net` for one shipment, but the
tracking page reads no number from the address and opens its empty form. The former tracker
took the number as `awbno` on `track.php`.

## Testing

`npm run test:carriers:live -- carriers/atlantic-courier`, with `ATLANTIC_COURIER_TRACKING_NUMBER`
and optionally `ATLANTIC_COURIER_DELIVERED_NUMBER` and `ATLANTIC_COURIER_UNKNOWN_NUMBER` set
outside the repository.
