# Poste Italiane fixtures

- `delivered.json`: full DoveQuando envelope for a delivered parcel (`esitoRicerca` `3`,
  `stato` `5`, an estimate line, four movements) plus the sender, recipient, address,
  signature, office and weight blocks the parser must drop. Every identifier, name and
  address is synthetic.
- `registered-mail.json`: a registered letter (`tipoSpedizione` `C`, `RACC. GENERICHE`) accepted
  at a post office, sorted, then held at another office for collection. Each movement carries
  the office blocks the parser must drop. Every identifier and office is synthetic.
- `from-abroad.json`: an express item from Japan, which Poste's tracker follows under the Japanese
  post's S10 number (`EXPRES DA/PER ESTERO`, `tipoSpedizione` `C`): abroad, released by customs at
  the international office, then out for delivery. Its shape and wording follow the redacted
  reply in the [prior-art client's tests](https://github.com/ha-parcel-integrations/ha-poste-italiane/blob/dbf814a5c1319f77af9855abe5f014e10a829902/tests/payloads.py).
  The number, clocks and places are synthetic.
