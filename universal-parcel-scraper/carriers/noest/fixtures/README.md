# Fixtures

Pages of `https://app.noest-dz.com/list/t`, cut down to the parts the adapter reads and kept
in the shape the tracker serves them. `page.html` is the empty form with its token.
`delivered.html` is the form's answer for a parcel delivered after one failed attempt, with
the payout to the merchant after the delivery and a note under the failed attempt.
`in-transit.html` is the answer for a parcel received at a hub. `not-found.html` is the answer
for a number NOEST does not hold: the form showing the number again, without a box.

Numbers, tokens, notes and clocks are invented.
