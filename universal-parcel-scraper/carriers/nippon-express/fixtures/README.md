# Fixtures

`transit.html` follows the shape of the list Nippon Express's air tracker renders for one slip
number it holds: the number linked to its detail page, the latest status over its clock, the
acceptance day, the designated delivery day and the service. `not-found.html` is the row for a
number it does not hold, `error.html` the page it shows after a lost session and `search.html`
its search form. Numbers, session ids, tokens, days and clocks are invented. The tracker sends
Windows-31J; the fixtures are stored as UTF-8 and the tests encode them as Shift_JIS where the
decoding matters.
