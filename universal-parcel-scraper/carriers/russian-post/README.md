# Russian Post

Tracks domestic Russian Post barcodes and postal S10 items through the anonymous JSON read
used by the official tracking page.

## Retrieval

One `direct` GET reads `www.pochta.ru/api/tracking/api/v1/trackings/detailed` with `language=en`
and the whole item in `track-numbers`. The returned `trackingItem.barcode` must match exactly.
The read needs no account, page bootstrap, session cookie or CSRF token.

Unknown identifiers receive an echoed `IN_PROGRESS` shell with no operations. That stays
inconclusive; it does not prove shipment existence or absence. HTTP 417 is the foreign-network
block, and an unavailable API route is a transport failure.

Only real tracking-history operations are read. Planned events, recipient and sender fields,
postcodes, payment information and account fields are excluded. Scan timestamps retain the
offset the source states. The summary's clock does not replace those scan clocks.

A return operation starts the return leg. Later sorting or transport stays active; a delivery
operation completes a return only with that leg's context or the carrier's return flag. The
single-scan status map leaves delivery codes for the adapter to interpret with that context.

Operations are staged by their type and attribute codes. The international exchange codes the
page has not shown yet are mapped from the operation list of the open-source
[lapaygroup/RussianPost](https://github.com/lapaygroup/RussianPost/blob/master/src/StatusList.php)
client, which names each operation in Russian.

## Network access

The website and tracking API require Russian egress. Consumers supply an appropriately routed
`fetcher`; no proxy credentials are bundled in the package.

## Numbers

Domestic Russian Post numbers are fourteen digits, as users quote them on gdeposylka: the
accepting office's six-digit postcode, seven digits and a GS1 check digit. Fourteen digits are
shared with several carriers. Russian postcodes never start with 8, yet the numbers starting with
80 that users and providers report are Russian Post's, so `russian-post-1` puts Russian Post
first for those when the check digit passes. It stays a suggestion: the other carriers' numbers of
that length are not ruled out. The adapter accepts other domestic barcodes with a passing
check digit when Russian Post is explicitly selected. International items use UPU S10; an `RU`
issuer proposes Russian Post for HTTP recognition, without assigning carrier ownership.

## Other official routes

The Android app (`com.octopod.russianpost.client.android`) uses
`mobileapp.russianpost.ru/mobile-api/method/<version>/`, which answers from abroad but disables
tracking for anonymous installs. Its `track.item.get` and `track.item.create` require a Pochta ID
login. The SOAP service at `tracking.russianpost.ru/rtm34` also requires account credentials.
Neither is needed for the public website read.

## Testing

Set `RUSSIAN_POST_TRACKING_NUMBER`, optionally `RUSSIAN_POST_UNKNOWN_NUMBER`, and
`RUSSIAN_POST_PROXY_URL` outside Git, then run:

```sh
npm run test:carriers:live -- carriers/russian-post
```
