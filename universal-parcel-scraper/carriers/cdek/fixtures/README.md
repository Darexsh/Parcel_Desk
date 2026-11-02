# Fixtures

`pickup.json` and `courier.json` follow the shape of the tracking service's reply for an order:
the order's number, its milestones oldest first with the scans in each grouped by city, a
milestone it has not reached yet marked as future, the current status and the page's widget,
and the recipient's initials, the addresses, offices, phones, coordinates and pickup code the
adapter never reads. Numbers, names, places, clocks and codes are invented. `not-found.json` is
the reply for a number the service does not know.
