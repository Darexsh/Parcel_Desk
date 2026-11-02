# Fixtures

`delivered.json` is a synthetic awb-history reply: the AWB, parcel number, clocks, counties,
country and depot are invented. The shape follows the live reply: the AWB's own history newest
first, each parcel's scans oldest first with its parcel number and return flag, offset clocks,
and the service flags. It is a single-parcel AWB delivered to an easybox, with a redirection
instruction before the pickup.
