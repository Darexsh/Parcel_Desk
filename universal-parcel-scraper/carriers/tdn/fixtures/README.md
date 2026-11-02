# Fixtures

Each file is the page TDN's tracker returns for one reference, cut down to its head, header,
tracking panel and footer. The panel repeats the reference in a heading, then has a progress
rail of four slots; the current slot holds the status, the branch's number and the time, and a
row of circles below marks the steps passed.

`delivered.html` holds a delivery in the last slot. `in-transit.html` holds a parcel out for
delivery in the third slot. `not-found.html` is the tracker's notice for an expedition it has
not registered, in the first slot.

The tracker sends its pages in windows-1252; the tests encode the files that way where the
encoding matters.

Numbers, branches and clocks are invented.
