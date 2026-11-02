# Fixtures

`search.html` is the search page HCT's app opens, with its WebForms state. `answer.html` is
the page the search posts back to: the same form, and the script that opens the result page
for the encrypted number. The ciphertext holds a `+` and a `/`.

The result pages follow `searchGoods_Main.aspx`: the number echoed, the notice field and the
scans, newest first, each with its clock and sentence. Branches and centres are links to their
phone numbers.

- `delivered.html`: a parcel collected, sent through a transfer centre, rescheduled after a
  first delivery round and delivered. The rescheduling is plain text.
- `in-transit.html`: a parcel sent on from a transfer centre.
- `pickup.html`: a number issued again. Its current pickup is collected; the rows of an older
  pickup a year earlier follow, and the pickup notice is appended last.
- `not-found.html`: the page's notice for a number without scans, with no number echoed.

Numbers, ciphertexts, page state, branches, centres, phone numbers and clocks are invented.
