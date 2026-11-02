# Fixtures

The `.html` files are the `html` of the lookup's `{"ok":true,"code":…,"html":…}` reply, which the
tests wrap in that envelope. Each has the summary with the code, the current status and the
facts, the sender and receiver, the timeline newest first and the hub that handles the parcel
with its phone numbers.

- `cancelled.html` follows a cancelled order: created, waiting for a rider, then pickups
  assigned and failed until the cancellation, whose line names only its hub. Its wordings are
  the ones seen live.
- `in-transit.html` is between hubs after a rider collected it, with one hub scan repeated.
- `delivered.html` goes from the order to the delivery.

The other two files' wordings that `cancelled.html` does not have follow Upaya's status names;
the tracker has not shown them yet. `not-found.json` and `invalid-code.json` are the whole
replies for a code Upaya does not know and for one it does not read as a tracking code.

Codes, names, places, phone numbers, amounts and clocks are invented.
