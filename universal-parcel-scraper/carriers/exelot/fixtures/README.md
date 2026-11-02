# Fixtures

Each fixture follows the reply of the lookup Exelot's tracker page makes,
`GET apiv2p.exelot.com/api/v2/parcels/tracking/details/{number}`: a list with one parcel per
number asked.

- `delivered.json` is a parcel flown from Great Britain, cleared through customs and delivered
  to the door, with its scans newest first. The delivery scan's place holds part of an address,
  and the parcel carries a remark, the buyer's masked contact details, the delivery partner's
  link and a note on the delivery that name people.
- `ready-for-pickup.json` is a parcel waiting at a pickup point after a customs hold for an ID.
  Its newest clock carries an offset other than UTC, the customs scan has only the clock the page
  prints, a code the map does not know shares an instant with a sorting scan, and its first scan's
  place holds a street.
- `not-found.json` is the answer for a number Exelot does not have.

Numbers, places, points, people, contact details, links and clocks are invented.
