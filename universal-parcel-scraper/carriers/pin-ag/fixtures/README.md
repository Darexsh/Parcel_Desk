# Fixtures

`delivered.json` and `undeliverable.json` follow the shape of the tracking service's reply:
statuses oldest first with their code, step, HTML label and clock, each with the recipient's
address, the depot's and the sender's customer number. Those fields hold `PRIVATE` placeholders
the adapter must not read. Codes, wordings and clocks are invented, apart from the delivered
status's code and wording.
