# Fixtures

Replies of the tracking page's `/seguimiento/{odt}/__data.json`, in devalue's flat list as the
page receives them, newest scan first. `delivered.json` goes from the sale to a delivery at the
door; two of its locations keep the reply's trailing space. `in-transit.json` is a parcel for
collection at an agency, waiting there for a delivery round, with two scans in one second.
`not-found.json` is the answer for an ODT the tracker does not know.

ODTs, agencies, towns and clocks are invented.
