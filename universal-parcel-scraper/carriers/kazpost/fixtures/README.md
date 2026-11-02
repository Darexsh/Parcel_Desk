# Fixtures

Each item has the API's two replies: `*.summary.json`, the item's summary with the sender and
receiver it names, and `*.events.json`, its scans grouped by day, newest first.

- `delivered` is mail from abroad, cleared by customs and delivered by courier. Its history holds
  the customs, bag, list and act scans the page hides, a sort corrected by an `_UNDO` scan, and a
  handover at the same second as the courier's delivery.
- `pickup` is a domestic item waiting at a post office after the courier could not deliver it.
- `in-transit` is a domestic item at a sorting centre, with a hand-over to the courier that an
  `_UNDO` scan cancels and one scan listed twice.
- `summary-only` is an item registered with no scan the page shows.
- `not-found.json` is the API's notice for a number its records do not hold, which both routes
  return.

Numbers, people, offices, addresses, postcodes, phone numbers and clocks are invented.
