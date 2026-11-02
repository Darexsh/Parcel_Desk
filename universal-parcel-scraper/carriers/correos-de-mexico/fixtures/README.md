# Fixtures

Each page follows the shape of Correos de México's tracking page after a lookup: the WebForms form
with its hidden fields, the number field, the year selector and either the history's five columns
with its event count or the no-information notice. `delivered.html`, `abroad.html`, `inbound.html`,
`returned.html` and `split-2026.html` are the page's own address for a number, which answers for
the current year. `split-2025.html` is the form's postback for the year before, holding the same
item's earlier events. `not-found.html` is the notice for a number without information. Numbers,
offices, receivers, form state and clocks are invented.
