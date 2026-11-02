# Fixtures

Each fixture follows the reply of the lookup Next Level's tracker page makes,
`POST api.nextlevel.delivery/v1/track` with `{"ids": [number]}`: one list of movements per number
asked, oldest first. A movement names the waybill, the subcontractor's waybill, its status id and
label, its place, description, comment, clock and the person who scanned it.

- `delivered.json` is a waybill created at a shop, collected by a courier, carried between two
  offices and delivered, with one movement listed twice. Comments name a phone number and whoever
  signed, and the delivery's place is an address.
- `abroad.json` is a waybill handed to a subcontractor, with the subcontractor's waybill on every
  movement, an office movement in the hour the autumn clock change repeats and a status id the map
  does not know.
- `returned.json` is a return shipment collected by a courier, picked up for the return and
  delivered back to its sender, naming its original waybill.
- `not-found.json` is the answer for a number the tracker does not have.

Waybills, shops, offices, places, people, phone numbers, notes and clocks are invented.
