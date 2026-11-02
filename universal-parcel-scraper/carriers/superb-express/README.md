# Superb Express

Superb Express parcels use enabled universal providers. There is no dedicated adapter.

Superb Express (SuperB Express International GmbH) is a Frankfurt forwarder for people in Germany sending
parcels home to China: customs-cleared lines for milk powder and groceries, and DHL's economy service to
China. It also sells DHL labels within Germany and to the rest of the EU. Its site is superb-express.com.

## Numbers

Its own waybill numbers are S numbers (S单号) of no published length. Parcels are handed to EMS, China Post or
DHL, which carry them under their own numbers, and those numbers stay with those carriers' rules. No public
page shows a Superb Express number, so there is no rule.

## Why there is no adapter

Its tracker reads an open endpoint without a CAPTCHA: `POST superb-express.com/site/search` with the numbers,
separated by commas, in the form field `tracking_code`. The page sets a session cookie, but the lookup needs no
token. The reply is JSON served as `text/html`; an unknown number gets HTTP 200 with code 100 and 未查询到信息
("no information found") in place of its scans. No public number is known to see a found reply.

## Links

The tracking page, `/site/searchview`, looks numbers up from its `tracking_code` parameter, several separated
by commas; the library reads the first.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
