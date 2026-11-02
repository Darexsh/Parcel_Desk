# Fixtures

`ready-for-pickup.json` follows the reply of the legacy tracking feed, with every field a scan
carries: a parcel waiting at the buyer's store, with a repeated arrival and the recipient's
name and phone in the reply. `no-history.json` is the answer for a number whose history has
expired, `unknown.json` the answer for a number the feed does not know, and `refused.json` the
gateway's refusal of a request without a browser's User-Agent.

Numbers, names, stores, phones and clocks are invented.
