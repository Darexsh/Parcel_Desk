# Dachser fixtures

- `in-transit.json` — synthetic in-transit shipment with four Spanish events and the party,
  contact, signature and internal-note fields the parser must drop.
- `null-result-500.json` — scrubbed JSON 500 for an unknown shipment/access tuple (not-found).
- `null-message-500.json` — the same 500 with `message: null`, which stays an upstream error.
