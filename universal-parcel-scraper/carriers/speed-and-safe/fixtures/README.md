# Fixtures

Replies of the ERP's `GET /online/getconsignmentstatus?consignmentno={number}`, in the shape of
live replies: the scans newest first, each with the route and number in `consignmentno`, its
branches, a one-letter `transit` code, a timestamp with its offset and a status ending in a
dash. `delivered.json` goes from the booking branch through a hub to the delivering franchisee:
one dispatch is repeated at the same instant and another comes a few seconds earlier, the
oldest arrival has no `source` and a timestamp without a fraction of a second, and the delivery
carries the branch's phone. `in-transit.json` has reached its first hub. `not-found.json` is
the answer for a number the ERP holds nothing under.

Numbers, branches, places, phones and clocks are invented.
