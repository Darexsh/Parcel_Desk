# Post One

Post One parcels use enabled universal providers. There is no dedicated adapter yet.

Post One Group is a licensed Bulgarian postal operator for cross-border e-commerce. It
consolidates parcels in Sofia and hands them to a partner in the destination country, such as
Hermes in Germany, SPS in Slovakia or USPS. Its site is postone.eu.

## Numbers

Post One's item number is R and ten digits. Archived lookups on its tracker show several, and
it still answers the two looked up again. GLS Italy's `gls-it-digit-depot` takes any letter and ten digits, so
`post-one-1` stays a suggestion.

## Tracker

`/en/track?code=<number>` answers with an HTML page and no CAPTCHA. It also finds a parcel by its
partner's number and links to the partner's tracker. An unknown number redirects to the home
page.

## Links

The tracker opens a parcel from its `code` parameter, with or without a language prefix.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
