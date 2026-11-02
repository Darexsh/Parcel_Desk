# Fixtures

`delivered.xml` and `in-transit.xml` follow the reply of the e-Pak service's `Tracking_Pieza`: a
.NET dataset with its schema, then one row per state, oldest first, each naming the parcel, its
state with the branch appended, the reason and the branch. `delivered.xml` is a door delivery
from pickup to the proof of delivery scanned days later; one transit row is repeated.
`in-transit.xml` starts with a pickup dated without a clock, has two rows within one second and
ends with a visit that did not deliver and the new visit it set, both with their reason.
`not-found.xml` is the service's empty dataset for a number it does not know.

Numbers, branches, reasons and clocks are invented.
