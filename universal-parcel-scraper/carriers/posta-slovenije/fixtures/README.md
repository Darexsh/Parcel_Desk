# Fixtures

`delivered.json`, `returned.json` and `waiting.json` follow the shape of the app's guest tracking
reply: the parcel's state and its scans, oldest first, each with a code, Slovenian and English
wording, a clock labelled UTC, a post office and the fields the adapter leaves out, such as the
recipient, the signatory and pickup addresses. `abroad.json` is an item another post sent to
Slovenia: that post's events, on its wall clock read as Ljubljana time, then Pošta Slovenije's own
scans. Numbers, names, places, postcodes and clocks are invented. `not-found.json` is the reply for
a number the service does not know, and `refused.json` the one for a client it does not let in.
