# Fixtures

The pages follow the shape `herramientas_seguimiento_resultado.php` renders for one NIC: the
title with the NIC, the general panel with the loading date, the sender, the recipient and their
branches, and the tracking line, oldest event first, each with a numbered heading, a day, usually
a clock, and a branch.

- `delivered.html` goes from the dispatch's creation to the delivery.
- `in-transit.html` crosses New Year; its first event has no clock and one loading is listed
  twice.
- `not-found.html` is the notice for a NIC the tracker does not hold.

NICs, names, shops, branches and clocks are invented.
