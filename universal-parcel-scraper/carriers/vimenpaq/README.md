# Vimenpaq

Vimenpaq is a Dominican courier of Grupo Vimenca. It runs mailboxes in Miami and Spain for
shoppers in the Dominican Republic and ships between its branches in the country. Tracked
through the lookup the tracking page of its app makes.

## How it works

1. `direct`: one
   `POST https://ssl3.controlbox.net:8443/vimenpaq/APIVimenpaqClientes/api/Consultas/RastreoGuia?tracking={number}`
   with the JSON body `"{}"`, as the tracking page Vimenpaq's app opens sends it. It needs no
   account, cookie, key or browser. The JSON reply is the guide's record with its status rows.
2. `retry`: the same request once more when the first fails to reach the API or hangs. The
   first gets half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 200 with the same record left empty: no guide number and no rows.
  A 404 or a redirect is a moved route.
- The guide must carry the number asked, as its own number or as the tracking number it holds.
- Recognition makes the same request.

## Notes

- Vimenpaq runs on ControlBox, a courier platform. Its website links a ControlBox tracking
  form that renders the guide on the server, often with dates only; the adapter reads the JSON
  of the customer API instead, whose rows carry full clocks. [`controlbox.ts`](controlbox.ts)
  holds the request and the parser another ControlBox tenant can share; the API address, the
  name and the status map are Vimenpaq's.
- Each row's `CreatedDate` is a wall clock with no zone, so clocks stay `local_time`.
- A row's comment is free text that can name who took the parcel, so it is not read. Only the
  guide's numbers and its rows' clocks and wording are.

## Limitations

- No location, estimate, service or delivery time as an instant.
- The lookup does not know mailbox guides; Vimenpaq shows those in its customers' accounts.

## Numbers

The adapter takes 8 to 30 letters and digits, with at least one digit: a guide number, or the
tracking number a guide holds. There is no detection rule.

## Links

The website's tracker posts the number in a form, so no address opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/vimenpaq`, with `VIMENPAQ_TRACKING_NUMBER` and
optionally `VIMENPAQ_UNKNOWN_NUMBER` set outside the repository.
