# Fixtures

Replies of M-O's TM4Web trace at `https://cp.m-o.com/trace/`.

- `viewer.html` is the bill viewer's page after the trace form's post, cut down to its title,
  the search it writes back into its script and the element the bill opens in.
- `trace-found.json`, `trace-not-found.json` and `trace-several.json` are replies of
  `bill_details_ajax.msw` with `func=ExternalTrace`: a bill's id, the trace's answer for a number
  it does not hold, and the list of matches the viewer's script shows when several bills answer.
- `bill-delivered.json` and `bill-in-transit.json` are replies with `func=BillDetails`: the
  order, its freight, its status history and its trace numbers. The delivered history repeats
  one status; the bill on its way has a scheduled delivery over two days.
- `blocked.html` is a web server's refusal page.

The not-found reply is as the trace sent it. The bill replies keep the field names, layout,
clock format and padded bill number of a live reply, and the matches follow the viewer's
script; numbers, ids, zones, references, freight and dates are invented, and so are the
descriptions of the shipper's statuses.
