# Route 1 Group

Route 1 Group parcels use enabled universal providers. There is no dedicated adapter.

Route 1 Group, a family business in Northampton founded in 2013 as Route 1 Fulfilment Limited and
now run under Route 1 Group Holdings Limited, offers same-day courier work, two-person home delivery
and fulfilment, with a second site in Gloucestershire. Its site is route1groupltd.co.uk.

## Numbers

Its consignment codes for two-person deliveries are RO, seven digits, a hyphen and four digits. Its
customer hub's page holds a test code, which the tracker finds, and its former order tracker printed
an example, which the tracker no longer finds. Two examples do not establish the layout, and once
detection strips the hyphen the code has a shape La Poste's rule reads, so there is no rule.

## Why there is no adapter

The customer hub is a plain page that reads the code from its address without a login or CAPTCHA,
and says when it does not find a code. It shows a status message rather than scans, and finds a code
only with its hyphen, which an adapter would put back. The test code gets a generic message that the
team will be in touch, so the messages of real deliveries, and the stages they stand for, are
unknown.

## Links

The customer hub takes the code as `code` in its address, but only with the hyphen, which detection
strips, so there are no tracking links.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
