# Fixtures

The pages follow the shape of `cgi-bin/tracktrace.cgi?OBJ={code}`: one table per record, its
wording beside the item's code, then the record's clock, the system's name for the counter and
the clerk's login, followed by a link to the waybill's scan and the time the search took.

- `received.html`: an item with one record, the waybill taken in at a counter, as the tracker
  shows it.
- `history.html`: an item with three records. Only the first wording was seen on the tracker; the
  two later records, their wordings and their place as further tables are invented, to test
  wording the map does not know and a history of several records.
- `not-found.html`: the page for a code the lookup holds nothing for.
- `wrong-length.html`: the lookup's answer to a code that is not thirteen characters long.

Codes, clocks, counters, logins and search times are invented.
