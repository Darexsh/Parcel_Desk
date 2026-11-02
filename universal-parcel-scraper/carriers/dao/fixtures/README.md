# Fixtures

`home.json` and `shop.json` follow the shape of the tracking service's reply in English: the
parcel's number, the partner's number and link for a parcel sent abroad, its scans newest first,
each with the page's formatted date and wording and the backend's record (clock, event number,
wording, leg and place), the masked sender and recipient, and the pickup point with its address,
opening hours and coordinates. Numbers, names, places, clocks and masks are invented, and so is
the English wording of event 35. `not-found.json` is the reply for a number the service does not
know.
