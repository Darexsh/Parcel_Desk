# Packeta fixtures

- `delivered.json`: the `item` of a delivered parcel (`packetStatusId` `3`, merchant, Z-BOX,
  four English event sentences) plus recipient and signature fields the parser must drop.
  Constructed from the live contract; every identifier, name and address is synthetic.
- `handoff.json`: the `item` of a parcel on its way to DPD Germany (`packetStatusId` `31`,
  home delivery). Two sentences link DPD's parcel number to DPD's tracker, as the live API
  writes them. Every identifier, name and address is synthetic.
