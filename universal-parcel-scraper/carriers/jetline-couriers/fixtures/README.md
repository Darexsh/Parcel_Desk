# Fixtures

Pages of `www.jetlinecouriers.in` as it renders them for a client other than a browser, cut down
to the tracker's form and answer area, with their hidden form values replaced.

- `form.html` is the home page's form: the AWB field and its track button, the pincode search and
  the client login.
- `not-found.html` is the answer page for a number the tracker holds nothing under: an empty
  summary and the alert "No Record Available".
- `summary.html` is the answer page for a parcel booked in Samplepur, with its one summary row
  and the history link.
- `delivered.html` is the page that link opens for that parcel: the summary, its history through
  Exampleganj to its delivery in Testabad, with branch badges carrying addresses and phones, and
  the proof of delivery's photo.
- `in-transit.html` is the history page for a parcel booked in Samplepur and on its way.

Numbers, branches, addresses, phones, days and the photo are invented.
