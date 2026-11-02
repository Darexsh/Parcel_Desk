# VRL Logistics

VRL Logistics is an Indian road transport company. Its branches book parcels and part loads
that its own trucks carry between branches across India, for collection at the destination
branch or delivery to the door. Tracked through its tracking page.

## How it works

1. `direct`: one `POST https://www.vrlgroup.in/Tracking/TrackShipment` with the form body
   `lrno={number}`, as the page's form sends it. The form also sends an anti-forgery token and
   its cookie, which the page does not check, so the request needs no cookie, token or browser.
   The server renders the consignment's details and its transit rows, oldest first.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- An unknown LR number is HTTP 200 with the form and a `No data found` toast, which is not
  found. The `Invalid LR number` toast answers a number longer than ten digits and a request
  without one; for a nine- or ten-digit number it means the request changed. A 404 or a
  redirect is a moved route.
- The page must name the LR number asked.
- Recognition makes the same request. With no detection rule, preflight does not ask VRL.

## Notes

- Each transit row gives a status, its branch's name and code, and a clock written as
  `19:03, 06-Mar-2026`. The two digits after the hour are the month's number, not minutes, so
  each row keeps its day alone in `local_time`, with no `time`. Within a day, rows follow the
  page's order, and a row repeating the status and branch of another that day is kept once.
- The page's rail starts with the booking day at the first word of the booking branch's name
  and ends with the destination town. The adapter writes the booking as `Booked` at the branch
  the details card names and skips the rail's ends. A row with neither a time nor a day, which
  the page can list, is left out.
- The transit card's current status stages the consignment when the map knows its wording;
  otherwise the newest row with a stage does. `ARRIVED AT DESTINATION` stays in transit: the
  page does not say whether the consignment waits for collection or goes out to the door.
- The location is the branch's name. The branch codes, the destination branch, the package
  count and the delivery type are not kept. Every page carries a hidden sample card, which is
  not read.

## Limitations

- No scan or delivery time, no estimate, no weight and no sender or recipient.
- Records of old consignments expire, and the tracker answers them as not found.
- The page's courier tab posts VRL's courier numbers to another route, which the adapter does
  not use.

## Numbers

VRL tracks a consignment by its LR (lorry receipt) number, nine or ten digits. Digit runs of
these lengths are shared with other carriers, so no rule claims them. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The current tracker takes the LR number in a form post, so no link opens a consignment.
Former VRL tracking pages carried it in their addresses, and those addresses are recognized.

## Testing

`npm run test:carriers:live -- carriers/vrl-logistics`, with `VRL_LOGISTICS_TRACKING_NUMBER`
and optionally `VRL_LOGISTICS_UNKNOWN_NUMBER` set outside the repository.
