# Fixtures

The pages follow the shape `tracking.php?guia=` renders for one guía: the history card headed
with the guía, the claims notice, then the progress rail and the events under a heading for each
day, newest first, each with a clock, the guía's state, the event and sometimes a comment. The
site's own markup around the card is cut down.

- `delivered.html` goes from the label to the delivery, whose comment names the receiver and an
  ID number. The collection is listed twice.
- `in-transit.html` is on its way after the collection; its newest event is a wording the map does
  not know, beside the state `En camino`, and a comment carries a phone number.
- `not-found.html` is the notice for a guía the tracker does not hold.
- `empty-form.html` is the empty form the tracker shows for a guía whose series it does not
  issue, under an empty heading.

Guías, names, ID and phone numbers, the unknown event and the clocks are invented.
