# Fixtures

Both files follow the reply of `/api/v1/tracking/{number}`: the tracker's steps in journey
order, a timestamp on each step reached and a link on a step another network carries.

- `delivered.json` is a parcel sent abroad: dropped off with the drop-off network, whose link
  is on the collected step, then through Happy-Post's hub and international transit to a
  delivery whose step links the delivering network's tracking.
- `in-transit.json` is a domestic parcel at Happy-Post's hub. Its delivery step is not reached
  yet but already links the delivering network's tracking.

A number the service does not know gets an empty HTTP 404, which the tests build inline.

Numbers, links and clocks are invented.
