# Fixtures

`collected.json` and `attempted.json` follow the shape of the tracker's reply: one entry per
requested code, with a flag, a notice, a scan count and a list of scan slots padded with empty
ones, each scan with its date, time, station and English wording. Codes, stations and clocks
are invented. `not-found.json` is the reply for a code without history.
