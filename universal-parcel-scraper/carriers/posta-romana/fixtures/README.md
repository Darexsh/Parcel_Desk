# Fixtures

`collected.json`, `exported.json`, `returned.json` and `inbound.json` follow the shape of the
lookup's reply: flags, the item code, a summary and the scans oldest first, each with its date,
time, wording and site, and the office's opening hours on a scan that names them. Codes, sites
and clocks are invented. `exported.json` repeats one scan, and `returned.json` has two scans at
the same minute. `not-found.json` is the reply for an unknown code and `unregistered.json` the one
for unregistered mail.
