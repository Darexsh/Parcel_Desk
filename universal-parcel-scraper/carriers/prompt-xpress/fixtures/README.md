# Fixtures

The pages `web.promptxpress.lk/PublicTracking/TrackingStatus?trackingNo=` renders, with the
portal's long stylesheet left out and the search field's placeholder replaced.

- `delivered.html` is a found parcel whose newest movement is `Consignment Completed`, the
  wording a delivered parcel had live. Its proof of delivery, an image with a note naming the
  receiver, is laid out as the page's stylesheet and script expect one.
- `in-transit.html` is a found parcel whose newest movement is `In Transit` at a branch.
- `not-found.html` is the page for a number the portal holds nothing under: the notice
  "No tracking data was found for" and the number, with placeholders where a parcel's status,
  branch and clock would be.

Numbers, branches, clocks, scan counts, the in-transit wording and the proof are invented.
