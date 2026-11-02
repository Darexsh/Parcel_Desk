<div align="center">

<img src="docs/assets/pip.svg" width="112" alt="Pip, a kraft parcel with a face">

# Universal Parcel Scraper

**Parcel tracking that asks the carrier directly, from your own machine.**

The engine behind [Peek](https://peektracker.com) ([GitHub](https://github.com/plhery/peek-delivery-tracker)), the open-source parcel tracker for iPhone and the web.

[![npm](https://img.shields.io/npm/v/universal-parcel-scraper)](https://www.npmjs.com/package/universal-parcel-scraper)
[![CI](https://github.com/plhery/universal-parcel-scraper/actions/workflows/ci.yml/badge.svg)](https://github.com/plhery/universal-parcel-scraper/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/core-Apache--2.0-blue.svg)](LICENSE)

<!-- GENERATED:summary -->
**3,500+ carriers** through **700 dedicated adapters** and **5 universal fallbacks**

<sub>1311 catalog entries · 155 countries represented</sub>
<!-- /GENERATED:summary -->

[Try it](#try-it) · [Ways to run it](#ways-to-run-it) · [Benchmark](#benchmark) · [Carriers](carriers/) · [Add a carrier](CONTRIBUTING.md)

<img src="docs/assets/terminal.svg" width="840" alt="A terminal session: the detect command names UPS as the carrier of a tracking number, then the track command prints a parcel's scans with their stages">

</div>

Give it a tracking number. It finds the carrier, fetches the history from the carrier's own
site and returns the same JSON for every carrier. No account, no API key.

It is the tracking engine of [Peek](https://github.com/plhery/peek-delivery-tracker), usable on
its own as a command, a Node library or an HTTP server.

## Benchmark

<!-- GENERATED:coverage -->
In a benchmark of 100 carriers picked for shoppers in Europe, run on public tracking numbers anyone can recheck, dedicated adapters return history for **91**, rising to **95** with all fallbacks enabled. The best single aggregator returns 73. Histories whose scans cannot be placed in time, which the library does not use, would add 28 for Postal Ninja and 3 for Ship24.

<img src="docs/assets/coverage.svg" alt="Carriers with tracking history: This project, all fallbacks enabled 95, This project, dedicated adapters alone 91, 17TRACK 73, ParcelsApp 72, Ship24 57, Postal Ninja 32, UPU 11." width="760">
<!-- /GENERATED:coverage -->

[Method, carriers and every number's results](benchmark/README.md)

## Try it

Needs Node.js 24 or newer.

```sh
npx universal-parcel-scraper detect 1Z999AA10123456784    # offline: names the carrier
npx universal-parcel-scraper track YOUR_TRACKING_NUMBER   # asks the carrier
```

Add `--carrier dhl` when a number fits several carriers. Some carriers also want
`--postcode` or `--tracking-url`.

## Ways to run it

### Command line

```sh
npm install -g universal-parcel-scraper
```

```sh
parcel-scraper detect <number, link or text>   # which carrier is this? no network
parcel-scraper track <number>                  # the parcel's history
parcel-scraper recognize <number>              # ask the possible carriers which one knows it
parcel-scraper carriers                        # the catalog, with the ids --carrier accepts
parcel-scraper serve                           # the HTTP API
```

Output is JSON, so it pipes into `jq`. `parcel-scraper --help` lists the environment variables.

### Node

```js
import { createTracker } from 'universal-parcel-scraper/node';

const tracker = createTracker();
const { carrier, source, result } = await tracker.track({ number: process.env.PARCEL_NUMBER });

console.log(carrier, result.current_stage);
for (const scan of result.events) {
  console.log(scan.time, scan.location, scan.description, scan.stage);
}
```

`source` names who answered and `attempts` lists what was tried. With no history, `track()`
throws a `TrackingError` carrying both. [Runnable example](examples/node.mjs).

`language` (`'fr'`, `'de-CH'`) asks carriers that can word their scans in the reader's
language to do so; the others answer as usual.

Besides the scans, `result` carries what the carrier shows about the parcel, such as
`expected_delivery`, `weight_kg`, `destination_country`, the shipping service in
`service_name` or the duties and fees an import owes in `import_charges`. A scan whose carrier
asks the recipient to give a tax number, pay import duties or send customs documents carries
`recipient_action`, and scans dated alike carry `tie_order`, their order from the oldest.

### Browser

```js
import { parseTrackingInput } from 'universal-parcel-scraper';

parseTrackingInput('1Z999AA10123456784');
// { carrier: 'ups', confidence: 'high', candidates: ['ups'], … }
```

Detection has no Node imports and makes no requests.

### HTTP and Docker

```sh
parcel-scraper serve --port 8080
```

```sh
docker run --rm -p 127.0.0.1:8080:8080 ghcr.io/plhery/universal-parcel-scraper:0.3.0
```

```sh
curl http://127.0.0.1:8080/v1/track \
  -H 'Content-Type: application/json' \
  -d '{"number":"1Z999AA10123456784","carrier":"ups"}'
```

The server caches answers in memory and rate-limits callers. It has no database and never
polls. The image ships Chromium. Routes are in the [OpenAPI file](server/openapi.json) and
settings, such as `SCRAPER_TOKEN` and `SCRAPER_TRUSTED_PROXIES`, in [.env.example](.env.example).

## What you can build with it

- A parcel-tracking app, like [Peek](https://github.com/plhery/peek-delivery-tracker).
- A [Home Assistant sensor](examples/home-assistant.yaml) for the parcel you are waiting on.
- Order status inside a shop or help desk, from any backend that speaks HTTP.
- Tracking numbers pulled out of shipping emails: `detect` reads pasted text and links.
- A cron job that pings you when `current_stage` turns `delivered`.

It answers one lookup at a time. Storing parcels and polling are yours.

## How it works

<img src="docs/assets/how-it-works.svg" width="840" alt="An input is detected offline and fetched by the carrier's dedicated adapter, or by a fallback you enabled when that finds no history or only part of it. Each scan's wording is filed under a stage, and the result is one timeline.">

**Fetching.** Adapters use plain HTTP where the site allows it. For sites that only answer a
browser, install `playwright-core sharp onnxruntime-web` and pass `chromiumPath`, or run the
[TRAWL browser service](trawl/README.md) and pass `trawlUrl`. Pass `userAgent` to name your
install to carriers.

**Fallbacks.** When an adapter finds no history, the lookup moves to the universal trackers
you enabled. When it finds only a current status or its newest scans, the tracker asks them
too and takes a fuller history that is not behind the carrier's. Only UPU is on by default.
Each one you enable receives the tracking number.

```js
createTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'Track718', 'UPU'] });
```

`track({ number, source: 'ParcelsApp' })` asks one enabled tracker alone, without the carrier;
the command line's `track --source ParcelsApp` does the same.

**Stages.** Carriers word the same moment differently. Every scan is filed under one stage:

<!-- GENERATED:stages -->
<img src="docs/assets/stages.svg" alt="DHL: Die Sendung wurde in das Zustellfahrzeug geladen.; Mondial Relay: En cours de livraison; Correios Brazil: Objeto saiu para entrega ao destinatário; Correos Express: EN REPARTO; Yamato Transport: 配達中; La Poste / Colissimo: DISTOU. All are filed under out_for_delivery." width="760">

The carrier folders record 18,364 such statuses, each filed under one stage.
<!-- /GENERATED:stages -->

Wording nobody recorded yet goes through a classifier that reads seven European languages.
[ARCHITECTURE.md](ARCHITECTURE.md) has the rest.

## Next to a hosted tracking API

| | Universal Parcel Scraper | Hosted tracking API |
| --- | --- | --- |
| Account | None | Sign-up and an API key |
| Cost | Your own compute | A plan or a per-shipment price |
| Who sees the tracking number | The carrier, plus any fallback you enable | The vendor, then the carrier |
| Updates | You poll | Webhooks |
| When a carrier changes its site | The adapter breaks until it is fixed here | The vendor deals with it |

## Privacy and limits

- A lookup sends the number to the carrier, with the postcode or tracking link when the
  carrier requires one. Enabled fallbacks receive the number too, and any postcode you supply.
- No telemetry. Server logs hold route names and outcomes, never parcel inputs.
- This is scraping: carriers change their sites and turn away automated requests. Keep to the
  catalog's refresh limits and to the retry advice in errors.
- A scan time with no known UTC offset is returned as the carrier wrote it.

## Contributing

Each carrier lives in its own folder with synthetic fixtures and offline tests.
`npm run carrier:new` scaffolds a new one. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). The optional TRAWL image is [AGPL-3.0](trawl/LICENSE). Credits are in
[NOTICE](NOTICE).
