# Fastgo

Fastgo parcels use enabled universal providers. There is no dedicated adapter.

Fastgo (速派快递), run by Fastgo Pty Ltd from Brisbane with a Shanghai trading company, carries parcels from
Australia and New Zealand to China, clears them through customs and hands them to EMS for delivery. Its
consolidation service, 速派集运 or 随意邮, ships shoppers' parcels from China to Australia, Japan and the United
States. Its site is fastgo.com.au. Fastgo Express in Canada, at fastgoexpress.com, carries the brand from Canada
to China.

## Numbers

The one public example, an archived reply of its own route API, is `AU`, nine digits and `SG`: shaped like an S10
number, but its S10 check digit does not fit. `fastgo-1` suggests that layout at low confidence, as it is the only
example. A number of that shape whose S10 check digit happens to fit stays with Singapore Post's rule.

## Why there is no adapter

Its tracking page reads an open JSON API without a session or CAPTCHA: `GET api.fastgoexp.com/api/route/{number}`,
or `POST api.fastgoexp.com/api/route/getRoutes` with a `billIds` list for several numbers. A found reply lists
the scans, on clocks without a zone, and names the carrier and number of the last leg, EMS in the public example.
The current host answers the expired public example and a made-up number alike with code `9999`, an unknown
error, so a missing parcel cannot be told apart from a failure. The older host, api.fastgoexpress.com, answers
the same path with code `0002`, number not found. No public number is known to see a found reply today. No
adapter has been written for it yet.

## Links

The tracking page opens numbers from its `bill` parameter; `from=bs` hides the page header.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
