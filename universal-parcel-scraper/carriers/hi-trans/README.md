# Hi-Trans Express

Hi-Trans Express consignments use enabled universal providers. There is no dedicated adapter.

## Numbers

Hi-Trans Express asks for the consignment note number. Its Freight API documentation looks up
three letters and three digits and says the prefix selects the sender's charge account. Many
carriers print letters followed by a counter, so no rule claims the layout.

## Links

The home page's track form opens `online.hi-trans.com.au/Connotes/ShowConsignmentSummary.aspx`
with the number in `Number`.

## Why there is no adapter

Cloudflare answers the consignment summary page, and every other page of the carrier's
sites, with an HTTP 403 challenge page before any result. The Freight API tracks a consignment
only with the username and token Hi-Trans issues to a customer, and Hi-Trans publishes no
tracking app, so Hi-Trans Express stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
