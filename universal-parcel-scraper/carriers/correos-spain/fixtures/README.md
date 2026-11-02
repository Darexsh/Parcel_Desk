# Correos fixtures

- `delivered.json`: `codError` `0` localizador envelope for a delivered parcel (admitted to
  delivered) with the office, weight, dimension and customer blocks, plus address, phone and
  signature fields the parser must drop. Every identifier, name and address is synthetic.
- `offices.json`: the office locator's reply for a search, listing a neighbouring office before
  the one the envelope names, with the phone, email, hours and coordinates the parser must drop.
  Synthetic.
