# InPost fixtures

- `delivered.json`: hub response for a delivered cross-border parcel (registration, middle
  mile, locker arrival, collection) with each scan's place, plus the recipient and signature
  fields the parser must drop. Constructed from the live hub shape; every identifier, name and address is synthetic.

The ShipX fixture models a target locker and a collected parcel. Its identifier,
clocks, point name and address are synthetic; forecast rows remain separate from scans.
