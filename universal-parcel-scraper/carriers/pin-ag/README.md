# PIN AG

PIN AG (PIN Mail) delivers letters and parcels in Berlin, Amazon parcels there among them, and
hands items for the rest of Germany to partner posts. Tracked through the service its own
tracking page calls.

## How it works

1. `direct`: one `GET https://sendungsverfolgung.pin-ag.de/api2/tracking?sendung={number}` with
   `Accept: application/json`. It needs no cookies, key, account or browser. The reply lists the
   item's statuses oldest first.
2. `retry`: one more try when the request fails to reach PIN or hangs. The first try gets half of
   the budget.

- The reply does not echo the number: the statuses are those of the number in the request.
- Each status names the step of the page's progress bar it belongs to (`stage`), which gives its
  stage. Its wording is the page's label, HTML removed, else its short description. The page
  files `NON_FURTHER_TRACKABLE` under In Zustellung, but its label says the item was only
  recorded at the sorting center and will be delivered without further updates, so it reads
  in transit. The page shows the depot's address and opening hours for `990302` alone: the item
  waits there for collection, so it reads ready for pickup.
- An unknown number, or one whose statuses PIN deleted after six months, gets HTTP 404 with the
  message "kein Zustellstatus gefunden": `NotFoundError`. So does a status coded
  `NOT_FOUND_HINT`, which the page treats the same way. HTTP 405 is an item type PIN does not
  track, such as a standard letter: inconclusive with the reason `tracking_withheld`. Any other
  refusal, and an empty status list, is inconclusive too.
- Recognition makes the same request. `pin-ag-1` offers PIN AG for sixteen digits opening `0100`
  next to DHL eCommerce and TNT, and preflight asks it only for a German country hint, since
  other carriers print such runs too.

## Notes

- The page shows each stamp in UTC, so the clock it shows is the one stored: Berlin's wall clock,
  labelled UTC. The adapter keeps it as a local time without an offset.
- Each status also carries the recipient's address, the depot's address and the sender's customer
  number. The adapter does not read them. The page reveals where an item was left once the
  recipient types their postcode; the adapter does not ask for it.

## Numbers

PIN publishes no layout. Parcel numbers typed into its tracking page, as the Wayback Machine
archived them, are sixteen digits opening `0100` with no check digit. Registered letters and
court deliveries carry thirteen digits, and a label can print part of a number in brackets,
which PIN's FAQ asks to leave out. The adapter takes thirteen or sixteen digits once brackets
and spaces are removed, and a number pasted with its last digit in brackets reads without them.
Sixteen digits are low rules of several carriers, so `pin-ag-1` stays low and only lists PIN AG
first.

## Limitations

Only items PIN tracks have history: registered letters, parcels and Amazon parcels in Berlin.
Standard letters do not, and an item PIN stops tracking at the sorting center never shows a
delivery. Statuses are deleted six months on. No delivery estimate, location,
weight, service, sender or recipient.

## Testing

`PIN_AG_TRACKING_NUMBER=... PIN_AG_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/pin-ag`
