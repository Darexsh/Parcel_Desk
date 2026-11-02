# Fixtures

Each file is the decrypted reply of `trackAjexShipments` in English; the tests encrypt it as the
service does before serving it. `delivered.json` comes from the older system behind `AJA`
numbers: numbered status codes, oldest scan first, a repeated hub scan, a failed attempt with
its reason, a hub city with "AJEX" in its name and the placeholder weight that system keeps.
`in-transit.json` comes from the newer system behind `A` numbers: `AJ00…` event codes with
notes, a failed pickup, a line-haul delay, a row without a status, which the page leaves out,
and the recipient's and sender's names, phones and addresses that the page never shows.
`not-found.json` is the answer for an `AJA` number AJEX does not know.

Numbers, names, phones, addresses, places, goods and clocks are invented.
