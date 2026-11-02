# USPS fixtures

`timeline.html` is the current `.tb-step` card markup (delivered, with collapsed history). `estimate.html` is a parcel on its way under the current estimate banner, whose weekday, date, month and year sit in elements of their own beside tooltips that reuse `.banner-header`. `delivered.html` and `in-transit.html` use the older history-table markup the parser keeps as a fallback. Numbers and locations are synthetic, and the signatory is a `PRIVATE RECIPIENT` placeholder the offline test asserts never reaches a result.
