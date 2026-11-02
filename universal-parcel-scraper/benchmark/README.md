# Carrier benchmark

Which sources return a parcel's history, carrier by carrier, on public tracking numbers
anyone can check again. The README's coverage figure comes from here.

## The carriers

The list is editorial: the carriers a shopper in Europe is most likely to receive a parcel
from. It covers the national posts and parcel networks across Europe, the integrators,
Amazon, the networks that carry Chinese marketplace orders and the largest carriers
elsewhere. Carriers outside the catalog may be listed, so the benchmark is not limited to
the carriers this project chose to build; keep those to fifteen at most. A network the
catalog lists among another carrier's aliases, as InPost lists Yodel, names that carrier
in `aliasOf` and is tracked by its adapter. [carriers.json](carriers.json) holds the list.

## The numbers

Each carrier has up to two public numbers. A catalog carrier's come from its
[corpus](../CORPUS.md), the most recent ones its folder records. The others cite their
public source in carriers.json. Never add a private number.

A carrier that shows history only with the delivery postcode needs a number whose source
gives the postcode too, such as an archived tracking link that carries both. The number then
lists that postcode, and every source is asked with it.

Public numbers age out: a carrier keeps a parcel's history for months, not years, so a
negative on an old number says little. Replace a number no source follows any more, and
rerun every source on the replacement.

## Reading the tables

A source has history for a carrier when it returned scans for at least one of its
numbers. Direct is the carrier's dedicated adapter, or for an alias the adapter of the
carrier it names; all fallbacks enabled counts a carrier when the adapter or any provider
has history.

A history is partial when it has a third of the rows of the fullest answer or fewer, when
most of its rows have no instant, or when its latest scan is more than a day older than
another source's. Postal Ninja's rows set no bar, because it lists each relaying service's
copy of a scan apart, and a scan dated after the day a source was asked does not count
against it. A dedicated adapter's scans at its carrier's wall clock count as dated: the
library keeps that clock as the carrier shows it. Partial histories still count.
Undated means a provider's history with no scan the library can place in time, at most
wall clocks whose zone it cannot tell; the library does not use it. Refused means the
number was not sent: its format is one the library or the adapter does not accept, often
because the carrier wants a postcode with it. Postcode prompt means the source asked for
one. Wrong carrier and other review notes are set by hand in carriers.json, with the reason.

17TRACK's form can offer an optional postcode for a parcel it does not have. That counts
as no history, not a prompt. Four numbers got one on 2026-10-10: DPD France
`250067589253957`, GEODIS `1GWSKFLSKX4Y`, and The Courier Guy `DD-KBA6JL` and
`LD-2C7WLM`, which 17TRACK took for GLS. No source had any of them. To ask again, with a
postcode if one turns up: `node scripts/benchmark.mjs probe --carriers
dpd-fr,geodis,the-courier-guy --sources 17TRACK`.

A number listed with its postcode fails at 17TRACK as `postcode_not_submitted` when 17TRACK
shows no postcode form for it: the browser service had nowhere to enter the postcode, so the
answer is not read as a negative. Those numbers were asked again without the postcode, and
17TRACK's no history from that lookup is what the tables show.

## Running it

```sh
export COVERAGE_PROBE_TRAWL_URL=http://localhost:8191   # TRAWL: 17TRACK, Postal Ninja, browser-backed adapters
export TRACKING_CHROMIUM_PATH=/path/to/chromium          # Ship24's recovery, local-browser adapters
node scripts/benchmark.mjs probe                          # every number through every source, about three and a half hours
node scripts/benchmark.mjs probe --carriers dhl,ups       # some carriers
node scripts/benchmark.mjs probe --unrun                  # numbers or sources never asked
node scripts/benchmark.mjs probe --sources 17TRACK --retry  # errors and challenges again
npm run generate                                          # tables below, provider order evidence, README counts
```

Answers merge into [results.jsonl](results.jsonl), one line per number and source: the
outcome, the scan count, the scans without an instant and how many of those keep a wall
clock, the newest scan's time and stage, the carrier names the source reported, the time
taken and the date checked. No event text is kept. A failed lookup does not replace an
earlier answer.

ParcelsApp's lookups start a minute apart, in a lane of their own: asked faster, it blocks
the address and then answers `NO_DATA` to every number (see its
[limitations](../providers/parcelsapp/README.md#limitations)). Ten of those in a row stop
its lane and are recorded as blocked, which `--retry` asks again.

Provider order follows the routing evidence in
[providers/coverage.json](../providers/coverage.json), described in
[COVERAGE.md](../providers/COVERAGE.md). `npm run generate` copies each catalog carrier's
provider answers there (`node scripts/benchmark.mjs routing`), one reference per number
graded as the tables below grade it, replacing those an earlier run wrote. A number no
source follows any more is marked stale there.

## Summary

<!-- GENERATED:summary -->
100 carriers, all in the catalog, checked between 2026-10-10 and 2026-10-27.

| Source | Carriers with history | Full | Partial | Undated only | Median answer |
| --- | ---: | ---: | ---: | ---: | ---: |
| This project, all fallbacks enabled | 95 | | | | |
| This project, dedicated adapters alone | 91 | 87 | 4 | 0 | 0.5 s |
| Ship24 | 57 | 47 | 10 | 3 | 0.9 s |
| ParcelsApp | 72 | 70 | 2 | 0 | 1.6 s |
| 17TRACK | 73 | 70 | 3 | 0 | 6.1 s |
| Postal Ninja | 32 | 28 | 4 | 28 | 6.8 s |
| UPU | 11 | 11 | 0 | 0 | 0.0 s |

5 carriers have no number any source still follows.
<!-- /GENERATED:summary -->

## Carriers

<!-- GENERATED:carriers -->
### France

| Carrier | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- |
| [La Poste / Colissimo](../carriers/la-poste/README.md) | ✓ 7 | ✓ 7 | ✓ 7 | ✓ 7 | No history | N/A |
| [Chronopost](../carriers/chronopost/README.md) | ✓ 20 | No history | ✓ 25 | ✓ 20 | No history | No history |
| [Mondial Relay](../carriers/mondial-relay/README.md) | ✓ 15 | No history | Postcode prompt | No history | No history | N/A |
| [Colis Privé](../carriers/colis-prive/README.md) | ✓ 11 | No history | No history | No history | No history | N/A |
| [DPD France](../carriers/dpd-fr/README.md) | ✓ 10 | ✓ 10 | ✓ 5 | ✓ 5 | No history | N/A |
| [GLS France](../carriers/gls-fr/README.md) | ✓ 15 | No history | ✓ 31 | ✓ 15 | ✓ 8 | N/A |
| [Relais Colis](../carriers/relais-colis/README.md) | ✓ 4 | No history | ✓ 4 | ✓ 3 | No history | N/A |
| [GEODIS](../carriers/geodis/README.md) | Summary only | No history | Postcode prompt | ✓ 4, partial | ✓ 2 | N/A |
| [GOFO France](../carriers/gofo-fr/README.md) | ✓ 7 | ✓ 7 | ✓ 7 | ✓ 7 | ✓ 7 | N/A |
| [Asendia](../carriers/asendia/README.md) | ✓ 5 | ✓ 26, partial | ✓ 25 | ✓ 18 | ✓ 7, partial | ✓ 2 |

### Germany

| Carrier | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- |
| [DHL](../carriers/dhl/README.md) | ✓ 67 | ✓ 67 | ✓ 67 | ✓ 67 | No history | N/A |
| [Hermes Germany](../carriers/hermes-de/README.md) | ✓ 4, partial | ✓ 4, partial | ✓ 12 | ✓ 4, partial | ✓ 4, partial | N/A |
| [DPD Germany](../carriers/dpd-de/README.md) | ✓ 14 | ✓ 12 | ✓ 5 | ✓ 5 | ✓ 5 | N/A |
| [GLS Germany](../carriers/gls-de/README.md) | Postcode prompt | Refused | ✓ 3 | Refused | ✓ 4 | N/A |
| [DHL eCommerce](../carriers/dhl-ecommerce/README.md) | ✓ 11 | No history | ✓ 11 | ✓ 11 | Blocked | N/A |

### United Kingdom and Ireland

| Carrier | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- |
| [Royal Mail](../carriers/royal-mail/README.md) | ✓ 5 | No history | No history | No history | No history | No history |
| [Evri UK](../carriers/evri-uk/README.md) | ✓ 8 | ✓ 16, partial | ✓ 14 | ✓ 7 | No history | N/A |
| [DPD UK](../carriers/dpd-uk/README.md) | ✓ 8 | ✓ 8 | ✓ 5 | ✓ 8 | ✓ 8 | N/A |
| [Parcelforce Worldwide](../carriers/parcelforce/README.md) | ✓ 10 | Undated | ✓ 6 | No history | Undated | No history |
| [DHL eCommerce UK](../carriers/dhl-ecommerce-uk/README.md) | ✓ 5 | ✓ 5 | No history | ✓ 5 | No history | N/A |
| [Yodel](../carriers/inpost/README.md) | ✓ 8 | ✓ 8 | No history | ✓ 9 | Undated | N/A |
| [An Post](../carriers/an-post/README.md) | ✓ 6 | ✓ 6 | ✓ 6 | ✓ 4 | ✓ 6 | No history |

### Benelux

| Carrier | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- |
| [PostNL](../carriers/spring-gds/README.md) | ✓ 17 | ✓ 17 | ✓ 17 | No history | ✓ 27 | No history |
| [bpost](../carriers/bpost/README.md) | ✓ 14 | No history | ✓ 20 | ✓ 14 | Undated | No history |
| [DHL eCommerce Netherlands](../carriers/dhl-ecommerce-nl/README.md) | ✓ 50 | ✓ 39 | ✓ 50 | ✓ 49 | ✓ 49 | N/A |
| [Landmark Global](../carriers/landmark-global/README.md) | ✓ 16 | ✓ 27 | ✓ 24 | ✓ 16 | Undated | N/A |

### Across Europe

| Carrier | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- |
| [Amazon Logistics](../carriers/amazon-logistics/README.md) | No adapter | No history | No history | No history | No history | N/A |
| [Amazon Shipping](../carriers/amazon-shipping/README.md) | ✓ 11 | ✓ 11 | ✓ 11 | ✓ 11 | Undated | N/A |

### Switzerland and Austria

| Carrier | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- |
| [Swiss Post](../carriers/swiss-post/README.md) | ✓ 9 | ✓ 13 | ✓ 20 | ✓ 22 | ✓ 27 | ✓ 7 |
| [DPD Switzerland](../carriers/dpd/README.md) | No history | No history | ✓ 5 | No history | No history | N/A |
| [Planzer](../carriers/planzer/README.md) | ✓ 6 | No history | No history | ✓ 6 | No history | N/A |
| [Austrian Post](../carriers/austrian-post/README.md) | ✓ 9 | ✓ 9 | ✓ 9 | ✓ 9 | ✓ 9 | No history |

### Nordics and Baltics

| Carrier | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- |
| [PostNord](../carriers/postnord/README.md) | ✓ 7 | ✓ 8 | ✓ 7 | ✓ 8 | ✓ 8 | No history |
| [Bring](../carriers/bring-posten/README.md) | ✓ 9 | ✓ 8 | ✓ 8 | ✓ 8 | ✓ 10 | N/A |
| [Posti](../carriers/posti/README.md) | No history | No history | No history | No history | No history | No history |
| [Omniva](../carriers/omniva/README.md) | ✓ 1 | ✓ 1 | ✓ 1 | No history | Undated | No history |

### Italy

| Carrier | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- |
| [Poste Italiane](../carriers/poste-italiane/README.md) | ✓ 11 | ✓ 10 | ✓ 10 | ✓ 10 | ✓ 9 | N/A |
| [BRT](../carriers/brt/README.md) | ✓ 9 | No history | ✓ 23 | ✓ 9 | ✓ 5, partial | N/A |
| [SDA](../carriers/poste-italiane/README.md) | ✓ 3 | ✓ 3 | ✓ 28 | ✓ 6, partial | ✓ 3 | N/A |
| [GLS Italy](../carriers/gls-it/README.md) | ✓ 14 | ✓ 12 | ✓ 12 | ✓ 12 | ✓ 12 | N/A |

### Spain and Portugal

| Carrier | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- |
| [Correos](../carriers/correos-spain/README.md) | ✓ 10 | ✓ 9 | ✓ 10 | ✓ 10 | ✓ 10 | No history |
| [SEUR](../carriers/seur/README.md) | ✓ 4 | ✓ 4 | ✓ 5 | ✓ 5 | ✓ 5 | N/A |
| [Correos Express](../carriers/correos-express/README.md) | ✓ 9 | ✓ 17 | ✓ 9 | ✓ 9 | No history | N/A |
| [MRW](../carriers/mrw/README.md) | ✓ 14 | ✓ 14 | ✓ 14 | ✓ 14 | ✓ 14 | N/A |
| [NACEX](../carriers/nacex/README.md) | ✓ 13, partial | Refused | Refused | Refused | Refused | N/A |
| [TIPSA](../carriers/tipsa/README.md) | ✓ 13 | No history | Postcode prompt | No history | No history | N/A |
| [CTT Portugal](../carriers/ctt/README.md) | ✓ 9 | ✓ 9 | ✓ 9 | ✓ 9 | Undated | ✓ 2 |
| [CTT Express](../carriers/ctt-express/README.md) | ✓ 11 | ✓ 8 | ✓ 32 | ✓ 4 | Undated | N/A |
| [DHL eCommerce Iberia](../carriers/dhl-ecommerce-es/README.md) | ✓ 11 | ✓ 11 | ✓ 20 | ✓ 11 | No history | No history |
| [Paack](../carriers/paack/README.md) | ✓ 9 | No history | ✓ 23 | No history | No history | N/A |
| [Ecoscooting](../carriers/ecoscooting/README.md) | ✓ 14 | ✓ 6 | ✓ 13 | ✓ 14 | Undated | N/A |
| [GLS Spain](../carriers/gls-es/README.md) | ✓ 5 | No history | No history | No history | No history | N/A |

### Central and Eastern Europe

| Carrier | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- |
| [InPost](../carriers/inpost/README.md) | ✓ 20 | ✓ 19 | Postcode prompt | ✓ 14 | No history | N/A |
| [Poczta Polska](../carriers/poczta-polska/README.md) | ✓ 10 | ✓ 20 | ✓ 19 | ✓ 21 | ✓ 18 | ✓ 6 |
| [DPD Poland](../carriers/dpd-pl/README.md) | ✓ 11 | ✓ 1, partial | ✓ 12 | ✓ 11 | ✓ 11 | N/A |
| [DHL eCommerce Poland](../carriers/dhl-ecommerce-pl/README.md) | ✓ 26 | ✓ 12 | No history | ✓ 24 | No history | N/A |
| [Packeta](../carriers/packeta/README.md) | ✓ 6 | ✓ 16, partial | No history | ✓ 10 | Undated | N/A |
| [Nova Poshta (Ukraine)](../carriers/nova-poshta/README.md) | ✓ 13 | No history | ✓ 26 | ✓ 13 | ✓ 13 | N/A |
| [Ukrposhta](../carriers/ukrposhta/README.md) | ✓ 22 | ✓ 30 | ✓ 33 | ✓ 45 | Undated | ✓ 11 |

### Southeastern Europe and Turkey

| Carrier | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- |
| [Speedy](../carriers/speedy/README.md) | ✓ 21 | No history | ✓ 21 | No history | No history | N/A |
| [FAN Courier](../carriers/fan-courier/README.md) | ✓ 2 | No history | No history | No history | No history | N/A |
| [Sameday](../carriers/sameday/README.md) | ✓ 16 | No history | No history | No history | Undated | N/A |
| [Yurtiçi Kargo](../carriers/yurtici-kargo/README.md) | ✓ 2 | No history | Postcode prompt | No history | No history | N/A |

### Global

| Carrier | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- |
| [DHL Express](../carriers/dhl-express/README.md) | ✓ 23 | ✓ 23 | ✓ 23 | ✓ 23 | Undated | N/A |
| [UPS](../carriers/ups/README.md) | ✓ 16 | ✓ 16 | ✓ 16 | ✓ 16 | ✓ 16 | N/A |
| [FedEx](../carriers/fedex/README.md) | ✓ 18 | No history | ✓ 18 | ✓ 18 | ✓ 18 | N/A |
| [TNT](../carriers/tnt/README.md) | No history | No history | No history | No history | No history | N/A |
| [EMS](../carriers/ems/README.md) | ✓ 9 | Undated | ✓ 19 | ✓ 28 | Undated | ✓ 6 |

### China

| Carrier | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- |
| [AliExpress / Cainiao](../carriers/aliexpress/README.md) | ✓ 24 | No history | ✓ 24 | ✓ 24 | Undated | N/A |
| [China Post](../carriers/china-post/README.md) | ✓ 4, partial | ✓ 7, partial | ✓ 20 | ✓ 56 | Undated | ✓ 7 |
| [Yanwen](../carriers/yanwen/README.md) | ✓ 19 | ✓ 20 | ✓ 24 | ✓ 19 | Undated | No history |
| [YunExpress](../carriers/yunexpress/README.md) | ✓ 25 | ✓ 33 | ✓ 24 | ✓ 26 | ✓ 33, partial | N/A |
| [4PX](../carriers/four-px/README.md) | ✓ 30 | ✓ 25 | ✓ 30 | ✓ 44 | Undated | N/A |
| [CNE Express](../carriers/cne/README.md) | ✓ 21 | ✓ 21, partial | No history | ✓ 20 | Undated | N/A |
| [SpeedPAK](../carriers/speedpak/README.md) | ✓ 14 | No history | ✓ 14 | No history | No history | N/A |
| [SunYou](../carriers/sunyou/README.md) | ✓ 8 | No history | ✓ 8 | ✓ 8 | No history | N/A |
| [SF Express](../carriers/sf-express/README.md) | ✓ 22 | No history | ✓ 26 | ✓ 27 | Undated | N/A |
| [JD Logistics](../carriers/jd-logistics/README.md) | Blocked | No history | No history | No history | No history | N/A |
| [YTO Express](../carriers/yto/README.md) | ✓ 30 | No history | ✓ 30 | No history | No history | N/A |

### Rest of the world

| Carrier | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- |
| [USPS](../carriers/usps/README.md) | ✓ 18 | No history | ✓ 18 | ✓ 18 | Blocked | No history |
| [OnTrac](../carriers/ontrac/README.md) | ✓ 7 | ✓ 7 | ✓ 7 | ✓ 7 | ✓ 7 | N/A |
| [GOFO Express](../carriers/gofo/README.md) | ✓ 12 | ✓ 12 | ✓ 27 | ✓ 12 | ✓ 8 | N/A |
| [UniUni](../carriers/uniuni/README.md) | ✓ 11 | ✓ 11 | ✓ 11 | ✓ 11 | Undated | N/A |
| [Canada Post](../carriers/canada-post/README.md) | ✓ 12 | ✓ 2, partial | ✓ 12 | ✓ 30 | Undated | ✓ 1 |
| [Purolator](../carriers/purolator/README.md) | ✓ 17 | ✓ 17 | ✓ 12 | ✓ 17 | No history | N/A |
| [Intelcom / Dragonfly](../carriers/intelcom/README.md) | ✓ 6 | ✓ 5 | ✓ 10 | ✓ 6 | ✓ 5 | N/A |
| [Australia Post](../carriers/australia-post/README.md) | ✓ 27 | ✓ 11 | ✓ 1, partial | No history | Undated | ✓ 1 |
| [NZ Post](../carriers/nz-post/README.md) | ✓ 29 | ✓ 20, partial | ✓ 40 | ✓ 29 | Undated | ✓ 4 |
| [Japan Post](../carriers/japan-post/README.md) | ✓ 10 | No history | Postcode prompt | ✓ 4 | Undated | N/A |
| [Yamato Transport](../carriers/yamato/README.md) | ✓ 7, partial | No history | Postcode prompt | ✓ 7 | No history | N/A |
| [Korea Post](../carriers/korea-post/README.md) | ✓ 10 | No history | ✓ 9 | ✓ 10 | No history | N/A |
| [Hongkong Post](../carriers/hongkong-post/README.md) | Summary only | ✓ 32 | ✓ 34 | ✓ 17 | Undated | No history |
| [Singapore Post](../carriers/singapore-post/README.md) | ✓ 7 | ✓ 4, partial | ✓ 9, partial | ✓ 31 | ✓ 11 | ✓ 4 |
| [India Post](../carriers/india-post/README.md) | ✓ 27 | ✓ 27 | No history | ✓ 27 | No history | No history |
| [Delhivery](../carriers/delhivery/README.md) | ✓ 2 | No history | Postcode prompt | No history | No history | N/A |
| [Correios Brazil](../carriers/correios-br/README.md) | ✓ 8 | Undated | ✓ 3 | ✓ 8 | Undated | No history |
| [Aramex](../carriers/aramex/README.md) | ✓ 26 | ✓ 26 | ✓ 26 | ✓ 26 | Undated | N/A |
| [J&T Express](../carriers/j-and-t/README.md) | ✓ 100 | No history | No history | No history | No history | N/A |
| [Ninja Van](../carriers/ninja-van/README.md) | No history | No history | No history | No history | No history | N/A |
| [The Courier Guy](../carriers/the-courier-guy/README.md) | ✓ 14 | No history | Postcode prompt | No history | No history | N/A |
<!-- /GENERATED:carriers -->

## Numbers

<!-- GENERATED:numbers -->
| Carrier | Number | Posted | Checked | Direct | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| La Poste / Colissimo | `5N30053962734` | [2026-10-01](https://fr.trustpilot.com/reviews/6abe6b377034c0d803771153) | 2026-10-15 | ✓ 7 | ✓ 7 | ✓ 7 | ✓ 7 | No history | N/A |
| La Poste / Colissimo | `6H14479158377` | [2026-09-28](https://web.archive.org/web/20260928081320/https://www.laposte.fr/outils/suivre-vos-envois?code=6H14479158377) | 2026-10-15 | ✓ 6 | ✓ 6 | ✓ 6 | ✓ 6 | No history | N/A |
| Chronopost | `PZ282567966EE` | [2026-09-14](https://web.archive.org/web/20260914161153/https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=PZ282567966EE) | 2026-10-15 | ✓ 1 | No history | No history | ✓ 1 | No history | No history |
| Chronopost | `015750676972097` | [2026-07-17](https://web.archive.org/web/20260717114015/https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=015750676972097&langue=en) | 2026-10-15 | ✓ 20 | No history | ✓ 25 | ✓ 20 | No history | N/A |
| Mondial Relay | `8565131824` | [2026-05-26](https://web.archive.org/web/20260526110712/https://www.mondialrelay.fr/suivi-de-colis?codeMarque=M1&numeroExpedition=8565131824&language=FR) | 2026-10-15 | ✓ 15 | No history | Postcode prompt | No history | No history | N/A |
| Mondial Relay | `89112087` | [2026-07-27](https://web.archive.org/web/20260727103710/https://www.mondialrelay.fr/suivi-de-colis?codeMarque=MR&numeroExpedition=89112087&language=FR) | 2026-10-15 | Postcode prompt | No history | No history | No history | No history | N/A |
| Colis Privé | `DG0013200753` | [2026-10-17](https://web.archive.org/web/20261017213329/https://www.colisprive.com/moncolis/pages/DetailColis.aspx?numColis=DG001320075369007) | 2026-10-27 | ✓ 5 | No history | No history | No history | No history | N/A |
| Colis Privé | `P50019442050` | [2026-10-14](https://web.archive.org/web/20261014185049/https://www.colisprive.com/moncolis/pages/DetailColis.aspx?numColis=P5001944205075019) | 2026-10-27 | ✓ 11 | No history | No history | No history | No history | N/A |
| DPD France | `10084004615036` | [2026-08-26](https://www.trustpilot.com/reviews/6a8eff71916b1b8a60cbc2b4) | 2026-10-15 | ✓ 10 | ✓ 10 | ✓ 5 | ✓ 5 | No history | N/A |
| DPD France | `250067589253957` | [2022-07-28](https://web.archive.org/web/20220728183621/https://trace.dpd.fr/en/trace/250067589253957) | 2026-10-15 | No history | No history | No history | No history | No history | N/A |
| GLS France | `ZX678O9N` | [2026-10-05](https://fr.trustpilot.com/reviews/6ac419b6850d07587d737214) | 2026-10-15 | ✓ 15 | No history | ✓ 31 | ✓ 15 | ✓ 10, partial (a third of the rows or fewer) | N/A |
| GLS France | `00LBJB4H` | [2026-10-02](https://fr.trustpilot.com/reviews/6abf6eb8b4ae84b01b59933d) | 2026-10-15 | ✓ 11 | No history | ✓ 7 | ✓ 11 | ✓ 8 | N/A |
| Relais Colis | `CC109000006501` | [2026-05-15](https://www.trustpilot.com/reviews/6a0790884a72dd12fbe83e46) | 2026-10-15 | ✓ 4 | No history | ✓ 4 | ✓ 3 | No history | N/A |
| Relais Colis | `VD2090015682` | [2023-08-09](https://suivi-colis.org/relais-colis-perdu/) | 2026-10-15 | No history | No history | No history | No history | No history | N/A |
| GEODIS | `1G25S92Z3AW7` | [2026-05-23](https://www.trustpilot.com/reviews/6a114cf1ee0c53c0f1aec420) | 2026-10-27 | Summary only | No history | Postcode prompt | ✓ 4, partial (stops early) | ✓ 2 | N/A |
| GEODIS | `1GWSKFLSKX4Y` | [2023-08-30](https://suivi-colis.org/espacedestinataire-livraison-geodis/) | 2026-10-27 | No history | No history | Postcode prompt | No history | No history | N/A |
| GOFO France | `PK-4948681651650700612-0` | [undated](https://parcelplus.app/fr/carriers/gofo-fr/track) | 2026-10-15 | ✓ 7 | No history | No history | No history | No history | N/A |
| GOFO France | `GFFR26162070068751` | [undated](https://parcelplus.app/fr/carriers/gofo-fr/track) | 2026-10-15 | ✓ 7 | ✓ 7 | ✓ 7 | ✓ 7 | ✓ 7 | N/A |
| Asendia | `LS244428589CH` | [2026-09-11](https://www.trustpilot.com/reviews/6aa36fc3b355e35ecf1ef14e) | 2026-10-15 | ✓ 5 | Undated | ✓ 6 | ✓ 5 | Undated | ✓ 2 |
| Asendia | `LS232735825CH` | [2026-07-28](https://www.trustpilot.com/reviews/6a680c8b8a48f47256b888b9) | 2026-10-15 | No history | ✓ 26, partial (stops early) | ✓ 25 | ✓ 18 | ✓ 7, partial (a third of the rows or fewer, stops early) | No history |
| DHL | `00340435061352161527` | [2026-10-07](https://de.trustpilot.com/review/www.dhl.de) | 2026-10-10 | ✓ 67 | ✓ 67 | ✓ 67 | ✓ 67 | No history | N/A |
| DHL | `232908780543` | [2026-09-27](https://www.paketda.de/fragen-antworten.php) | 2026-10-10 | ✓ 5 | No history | ✓ 5 | ✓ 5 | No history | N/A |
| Hermes Germany | `H1028030626845901017` | [2026-10-05](https://www.paketda.de/fragen-antworten.php?suche=H1028030626845901017) | 2026-10-15 | ✓ 4, partial (a third of the rows or fewer) | ✓ 4, partial (a third of the rows or fewer) | ✓ 12 | ✓ 4, partial (a third of the rows or fewer) | ✓ 4, partial (a third of the rows or fewer) | N/A |
| Hermes Germany | `02027150020212` | [2026-01-31](https://www.paketda.de/fragen-antworten.php?suche=02027150020212) | 2026-10-15 | No history | No history | No history | No history | No history | N/A |
| DPD Germany | `09446323296905` | [2026-10-05](https://www.paketda.de/fragen-antworten.php?suche=09446323296905) | 2026-10-15 | ✓ 14 | No history | ✓ 5 | ✓ 5 | ✓ 5 | N/A |
| DPD Germany | `01415130681967` | [2026-10-05](https://www.paketda.de/fragen-antworten.php?suche=01415130681967) | 2026-10-15 | ✓ 12 | ✓ 12 | ✓ 3, partial (a third of the rows or fewer) | ✓ 3, partial (a third of the rows or fewer) | ✓ 5 | N/A |
| GLS Germany | `37390065090` | [2026-08-24](https://de.reclabox.com/beschwerde/254878-gls-neuenstein-paket-ohne-zustellversuch-im-paketshop-abgekippt) | 2026-10-27 | Postcode prompt | No history | ✓ 3 | No history | ✓ 4 | N/A |
| GLS Germany | `AALZJR` | [2026-08-05](https://www.paketda.de/fragen-antworten.php?suche=AALZJR) | 2026-10-27 | Postcode prompt | Refused | Refused | Refused | Refused | N/A |
| DHL eCommerce | `420127019261290376171425385106` | [undated](https://webtrack.dhlglobalmail.com/?trackingnumber=420127019261290376171425385106) | 2026-10-15 | ✓ 11 | No history | ✓ 11 | ✓ 11 | Blocked | N/A |
| DHL eCommerce | `9261290316844317469885` | [undated](https://webtrack.dhlglobalmail.com/?trackingnumber=9261290316844317469885) | 2026-10-15 | ✓ 1 | No history | ✓ 1 | No history | Blocked | N/A |
| DHL eCommerce | `9261290357482657956985` | [2026-09-27](https://web.archive.org/web/20260927160405/https://webtrack.dhlecs.com/?trackingnumber=9261290357482657956985) | 2026-10-15 | ✓ 9 | No history | ✓ 9 | ✓ 7 | Blocked | N/A |
| Royal Mail | `MZ465962009GB` | [2026-03-16](https://web.archive.org/web/20260316193534/https://www.royalmail.com/portal/rm/track?trackNumber=MZ465962009GB) | 2026-10-15 | ✓ 5 | No history | No history | No history | No history | No history |
| Royal Mail | `IV745750017GB` | [2026-03-11](https://web.archive.org/web/20260311233047/https://www.royalmail.com/portal/rm/track?trackNumber=IV745750017GB) | 2026-10-15 | ✓ 5 | No history | No history | No history | No history | No history |
| Evri UK | `H00RVD0551541466` | [2026-10-06](https://web.archive.org/web/20261006223411/https://www.evri.com/track/parcel/H00RVD0551541466/details) | 2026-10-15 | ✓ 8 | ✓ 16, partial (stops early) | ✓ 7 | ✓ 7 | No history | N/A |
| Evri UK | `H01SVA0063090608` | [2026-10-04](https://web.archive.org/web/20261004063946/https://www.evri.com/track/parcel/H01SVA0063090608/details) | 2026-10-15 | ✓ 7 | ✓ 1, partial (a third of the rows or fewer, stops early) | ✓ 14 | ✓ 1, partial (a third of the rows or fewer, stops early) | No history | N/A |
| DPD UK | `15505780046243` | [2026-08-01](https://web.archive.org/web/20260801031820/https://www.dpd.co.uk/apps/tracking/?reference=15505780046243) | 2026-10-15 | ✓ 7 | ✓ 7 | ✓ 1, partial (a third of the rows or fewer) | ✓ 1, partial (a third of the rows or fewer) | ✓ 7 | N/A |
| DPD UK | `15502604121963` | [2026-07-21](https://web.archive.org/web/20260721060115/https://track.dpd.co.uk/search?reference=15502604121963) | 2026-10-15 | ✓ 8 | ✓ 8 | ✓ 5 | ✓ 8 | ✓ 8 | N/A |
| Parcelforce Worldwide | `GI049170518GB` | [2026-09-21](https://www.trustpilot.com/reviews/6ab10ab55824d015aa93bd4c) | 2026-10-15 | ✓ 3 | No history | ✓ 3 | No history | Undated | No history |
| Parcelforce Worldwide | `ED005806575GB` | [2026-09-15](https://web.archive.org/web/20260915140444/https://www.parcelforce.com/track-trace?trackNumber=ED005806575GB) | 2026-10-15 | ✓ 10 | Undated | ✓ 6 | No history | Undated | No history |
| DHL eCommerce UK | `60120261600869` | [2026-10-01](https://uk.trustpilot.com/reviews/6ac3cdda8e6383efe7f1ef5d) | 2026-10-15 | ✓ 4 | ✓ 4 | No history | ✓ 4 | No history | N/A |
| DHL eCommerce UK | `60120261424801` | [2026-10-01](https://uk.trustpilot.com/reviews/6abe414cdd8489abedbc0f2a) | 2026-10-15 | ✓ 5 | ✓ 5 | No history | ✓ 5 | No history | N/A |
| Yodel | `JJD0002233056208513` | [2026-07-21](https://uk.trustpilot.com/reviews/6a5f74addae5e57a5b7a80f6) | 2026-10-27 | ✓ 5 | ✓ 6 | No history | ✓ 6 | No history | N/A |
| Yodel | `JJD0002234785911878` | [2026-07-11](https://uk.trustpilot.com/reviews/6a523cd283fc2addfafca1e5) | 2026-10-27 | ✓ 8 | ✓ 8 | No history | ✓ 9 | Undated | N/A |
| An Post | `CD009466316IE` | [2026-09-24](https://www.trustpilot.com/reviews/6ab509af46eee3df19b6496d) | 2026-10-10 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | No history |
| An Post | `AY063253261IE` | [2026-09-21](https://web.archive.org/web/20260921201835/https://www.anpost.com/Post-Parcels/Track/History?item=AY063253261IE) | 2026-10-10 | ✓ 6 | ✓ 6 | ✓ 6 | No history | ✓ 6 | No history |
| PostNL | `3SINHW532911189` | [2026-10-03](https://www.klacht.nl/postnl/klacht/pakket-niet-aangekomen-bij-klant/) | 2026-10-15 | No history | No history | Postcode prompt | No history | No history | N/A |
| PostNL | `LX038154718NL` | [2026-08-05](https://web.archive.org/web/20260805154833/https://postnl.post/track?barcodes=LX038154718NL) | 2026-10-15 | ✓ 17 | ✓ 17 | ✓ 17 | No history | ✓ 27 | No history |
| bpost | `323299903171288510995037` | [2026-09-18](https://www.trustpilot.com/reviews/6aad4fb49a4ec9a1f36c3a6c) | 2026-10-15 | ✓ 11 | No history | Postcode prompt | ✓ 11 | No history | N/A |
| bpost | `LD737351137BE` | [2026-09-18](https://www.trustpilot.com/reviews/6aad494aa36ef0697f60cd4d) | 2026-10-15 | ✓ 14 | No history | ✓ 20 | ✓ 14 | Undated | No history |
| DHL eCommerce Netherlands | `JVGL08035717002011328118` | [2026-09-21](https://ie.trustpilot.com/review/dhlecommerce.nl) | 2026-10-15 | ✓ 50 | ✓ 39 | ✓ 50 | ✓ 49 | ✓ 49 | N/A |
| DHL eCommerce Netherlands | `3SMOP10072829` | [2026-03-27](https://web.archive.org/web/20260327101353/https://api-gw.dhlparcel.nl/track-trace?key=3SMOP10072829&withView=true) | 2026-10-15 | ✓ 5 | No history | Postcode prompt | No history | No history | N/A |
| Landmark Global | `LTN480634985` | [2026-09-23](https://www.trustpilot.com/reviews/6ab3ef95f2b298d50182689a) | 2026-10-15 | ✓ 14 | ✓ 22 | ✓ 21 | ✓ 14 | Undated | N/A |
| Landmark Global | `LTN461901299` | [2026-06-30](https://www.trustpilot.com/review/landmarkglobal.com) | 2026-10-15 | ✓ 16 | ✓ 27 | ✓ 24 | ✓ 16 | Undated | N/A |
| Amazon Logistics | `TBA334610324555` | [2026-09-22](https://web.archive.org/web/20260922192236/https://track.amazon.com/tracking/TBA334610324555) | 2026-10-27 | No adapter | No history | Error | No history | No history | N/A |
| Amazon Logistics | `DE5679225276` | [2026-08-05](https://www.paketda.de/fragen-antworten.php?suche=DE5679225276) | 2026-10-27 | No adapter | No history | No history | No history | No history | N/A |
| Amazon Shipping | `TBA335091478685` | [2026-10-05](https://web.archive.org/web/20261005182927/https://track.amazon.com/tracking/TBA335091478685) | 2026-10-15 | ✓ 11 | ✓ 11 | ✓ 11 | ✓ 11 | Undated | N/A |
| Amazon Shipping | `UK4889319345` | [2026-10-05](https://web.archive.org/web/20261005184419/https://track.amazon.co.uk/tracking/UK4889319345) | 2026-10-15 | ✓ 1 | ✓ 1 | ✓ 1 | No history | Undated | N/A |
| Swiss Post | `LT063514435CH` | [2026-09-29](https://web.archive.org/web/20260929162717/https://service.post.ch/ekp-web/ui/entry/search/LT063514435CH?lang=de) | 2026-10-15 | ✓ 9 | ✓ 7 | ✓ 20 | ✓ 20 | ✓ 27 | ✓ 7 |
| Swiss Post | `LT383724833CH` | [2026-09-22](https://www.chinapostaltracking.com/qa/customs-clearance-assistance-required--lt383724833ch-161173/) | 2026-10-15 | ✓ 8 | ✓ 13 | ✓ 13 | ✓ 22 | ✓ 13 | ✓ 5 |
| DPD Switzerland | `06086216767970` | [undated](https://www.paketda.de/fragen-antworten.php) | 2026-10-27 | No history | No history | ✓ 5 | No history | No history | N/A |
| Planzer | `87979.0061660090` | [2026-07-02](https://www.trustpilot.com/reviews/6a463a9fe1dee431b2338215) | 2026-10-15 | ✓ 4 | No history | No history | No history | No history | N/A |
| Planzer | `61214174` | [2026-07-01](https://www.trustpilot.com/reviews/6a45580211a8ca65d11c1072) | 2026-10-15 | ✓ 6 | No history | No history | ✓ 6 | No history | N/A |
| Austrian Post | `1040906599808880244007` | [2026-08-07](https://www.trustpilot.com/reviews/6a75ae37aa311760875cbad5) | 2026-10-15 | ✓ 9 | ✓ 9 | ✓ 9 | ✓ 9 | ✓ 9 | N/A |
| Austrian Post | `CA643257963AT` | [2026-03-04](https://www.paketda.de/fragen-antworten.php?suche=CA643257963AT) | 2026-10-15 | No history | No history | No history | No history | No history | No history |
| PostNord | `RR078278874SE` | [2026-10-05](https://web.archive.org/web/20261005093915/https://tracking.postnord.com/en/tracking?id=RR078278874SE) | 2026-10-15 | ✓ 7 | ✓ 7 | ✓ 7 | ✓ 7 | ✓ 7 | No history |
| PostNord | `00357059930440074440` | [2026-10-01](https://web.archive.org/web/20261001013540/https://tracking.postnord.com/dk/tracking?id=00357059930440074440) | 2026-10-15 | ✓ 6 | ✓ 8 | No history | ✓ 8 | ✓ 8 | N/A |
| Bring | `70733748769774711` | [2026-10-07](https://web.archive.org/web/20261007113854/https://sporing.posten.no/sporing/70733748769774711) | 2026-10-15 | ✓ 9 | ✓ 8 | ✓ 8 | ✓ 8 | ✓ 10 | N/A |
| Bring | `370722152621578495` | [2026-09-30](https://web.archive.org/web/20260930004423/https://tracking.bring.dk/tracking/370722152621578495) | 2026-10-15 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | No history | N/A |
| Posti | `00264300487130023858` | [2026-09-03](https://github.com/ItellaPlugins/itella-shipping-woocommerce/issues/224) | 2026-10-27 | No history | No history | No history | No history | No history | N/A |
| Posti | `LV679342632US` | [2025-04-22](https://www.trustpilot.com/reviews/6807896d85762edcd5ff538f) | 2026-10-27 | No history | No history | No history | No history | Blocked | No history |
| Omniva | `RL714436355EE` | [2026-05-13](https://www.sudzibas.lv/omniva/omniva-pakalpjomu-sanemsanas-neiespejamiba-c2656532) | 2026-10-15 | ✓ 1 | ✓ 1 | ✓ 1 | No history | Undated | No history |
| Poste Italiane | `3UW1QJ9006998` | [2026-09-23](https://it.trustpilot.com/reviews/6ab90c6ff003fb5850dcfa17) | 2026-10-15 | ✓ 9 | ✓ 9 | ✓ 9 | ✓ 9 | ✓ 9 | N/A |
| Poste Italiane | `RA 00032528599` | [2026-09-02](https://it.trustpilot.com/reviews/6a97ee2da1cdc686b65e69ab) | 2026-10-15 | ✓ 11 | ✓ 10 | ✓ 10 | ✓ 10 | No history | N/A |
| BRT | `04503190170072` | [2026-09-28](https://www.trustpilot.com/reviews/6aba3931d3ae76dee1ac45cf) | 2026-10-15 | ✓ 9 | No history | ✓ 23 | ✓ 9 | ✓ 5, partial (a third of the rows or fewer) | N/A |
| BRT | `107180064942` | [2026-07-09](https://web.archive.org/web/20260709102539/https://vas.brt.it/vas/sped_det_show.hsm?reqid=&pagina=&ksu=&chiamante=&nspediz=107180064942&keygiac=&npr=&norm=) | 2026-10-15 | ✓ 7 | No history | No history | ✓ 7 | No history | N/A |
| SDA | `974D81042885F` | [2026-10-03](https://www.altroconsumo.it/reclamare/bacheca-dei-reclami/x/b0fc621d40cde1ea8f) | 2026-10-27 | ✓ 3 | ✓ 3 | No history | No history | ✓ 3 | N/A |
| SDA | `964D80079157F` | [2026-08-12](https://www.altroconsumo.it/reclamare/bacheca-dei-reclami/pacco-dichiarato-consegnato-ma/8c0de968cf63956b3d) | 2026-10-27 | No history | ✓ 6, partial (a third of the rows or fewer, stops early) | ✓ 28 | ✓ 6, partial (a third of the rows or fewer, stops early) | Undated | N/A |
| GLS Italy | `CL 660213461` | [2026-10-02](https://it.trustpilot.com/review/gls-italy.com?sort=recency) | 2026-10-15 | ✓ 14 | ✓ 10 | ✓ 11 | ✓ 11 | No history | N/A |
| GLS Italy | `ww668513923` | [2026-07-02](https://www.altroconsumo.it/reclamare/bacheca-dei-reclami/spedizione-bloccata-a-gls-capu/d7f3f9e87fa92e0b1c) | 2026-10-15 | ✓ 12 | ✓ 12 | ✓ 12 | ✓ 12 | ✓ 12 | N/A |
| Correos | `PHAS9C041996281E` | [2026-08-17](https://es.trustpilot.com/reviews/6a83008bf44f16ad720a6d32) | 2026-10-15 | ✓ 10 | No history | ✓ 10 | ✓ 10 | ✓ 10 | N/A |
| Correos | `LX309102212ES` | [2026-09-18](https://www.ocu.org/reclamar/lista-reclamaciones-publicas/entrega-de-paquete-abierto-y-s/bb3c389c2b30f513a5) | 2026-10-15 | ✓ 9 | ✓ 9 | ✓ 9 | ✓ 9 | ✓ 9 | No history |
| SEUR | `88380161263793` | [2026-09-30](https://www.ocu.org/reclamar/lista-reclamaciones-publicas/no-realizan-intento-de-entrega/addd747044249526a6) | 2026-10-15 | Error | No history | No history | No history | No history | N/A |
| SEUR | `07474002501967` | [2026-09-23](https://www.ocu.org/reclamar/lista-reclamaciones-publicas/han-ignorado-el-punto-de-entre/1626552520d044c1b1) | 2026-10-15 | ✓ 4 | ✓ 4 | ✓ 5 | ✓ 5 | ✓ 5 | N/A |
| Correos Express | `3230003401602989` | [2026-09-24](https://www.ocu.org/reclamar/lista-reclamaciones-publicas/error-al-visualizar-pin-probl/e22821af1ce1efd269) | 2026-10-15 | ✓ 9 | ✓ 17 | ✓ 9 | ✓ 9 | No history | N/A |
| Correos Express | `7983000739053141` | [2025-09-30](https://www.ocu.org/reclamar/lista-reclamaciones-publicas/incidencia-env-C3-ADo-imposible-h/0052eb4a8375da7128) | 2026-10-15 | No history | No history | No history | No history | No history | N/A |
| MRW | `02692S094204` | [2026-09-25](https://www.trustpilot.com/reviews/6ab63070e0b0b4688bf95e67) | 2026-10-15 | Summary only | No history | No history | ✓ 1 | No history | N/A |
| MRW | `04319F171575` | [2026-09-10](https://www.ocu.org/reclamar/lista-reclamaciones-publicas/demora-del-env-C3-ADo-sumado-a-malt/635ef0c643dc08ba3e) | 2026-10-15 | ✓ 14 | ✓ 14 | ✓ 14 | ✓ 14 | ✓ 14 | N/A |
| NACEX | `9999/16070306` | [2026-10-07](https://portaldaqueixa.com/brands/nacex/complaints/nacex-encomenda-marcada-como-entregue-nao-foi-recebida-163919126) | 2026-10-15 | ✓ 6, partial (undated rows) | Refused | Refused | Refused | Refused | N/A |
| NACEX | `0833/11354347` | [2026-09-25](https://www.ocu.org/reclamar/lista-reclamaciones-publicas/desconocimiento-falta-de-info/f097c972cba9d3c984) | 2026-10-15 | ✓ 13, partial (undated rows) | Refused | Refused | Refused | Refused | N/A |
| TIPSA | `0280010280017024953690` | [2026-08-25](https://www.deco.proteste.pt/reclamar/todas-as-reclamacoes/encomenda-n-C3-A3o-recebida/0e56c354319eb7d720) | 2026-10-15 | ✓ 13 | No history | Postcode prompt | No history | No history | N/A |
| TIPSA | `0000100000104002537106` | [2026-04-20](https://web.archive.org/web/20260420103951/https://aplicaciones.tip-sa.com/cliente/datos_env.php?id=0000100000104002537106) | 2026-10-15 | ✓ 11 | No history | Postcode prompt | No history | No history | N/A |
| CTT Portugal | `LA136353435PT` | [2026-09-28](https://portaldaqueixa.com/brands/ctt/complaints/ctt-atraso-na-entrega-377-163329926) | 2026-10-15 | ✓ 4 | ✓ 4 | ✓ 5 | ✓ 5 | Undated | ✓ 2 |
| CTT Portugal | `RL 2811 7996 5 PT` | [2026-05-16](https://portaldaqueixa.com/brands/ctt/complaints/ctt-nao-entrega-de-carta-registada-com-aviso-de-recepcao-1-155401326) | 2026-10-15 | ✓ 9 | ✓ 9 | ✓ 9 | ✓ 9 | No history | No history |
| CTT Express | `0082800082808877471638001` | [2026-10-07](https://www.ocu.org/reclamar/lista-reclamaciones-publicas/no-entrega-paquete-perdido-/62d22c49cc409fd333) | 2026-10-15 | ✓ 11 | No history | ✓ 32 | ✓ 4, partial (a third of the rows or fewer) | Undated | N/A |
| CTT Express | `0008180008189706230861` | [2026-09-29](https://www.ocu.org/reclamar/lista-reclamaciones-publicas/pedido-rechazado-/50f816f3d235552efe) | 2026-10-15 | ✓ 8 | ✓ 8 | ✓ 8 | ✓ 4 | Undated | N/A |
| DHL eCommerce Iberia | `CA732400595DE` | [2026-10-06](https://es.trustpilot.com/reviews/6ac49bcee7e7b3a98bf827c6) | 2026-10-15 | ✓ 10 | ✓ 11 | ✓ 20 | ✓ 11 | No history | No history |
| DHL eCommerce Iberia | `CC502655557DE` | [2026-09-07](https://es.trustpilot.com/reviews/6a9eaa3163863b88e9e12967) | 2026-10-15 | ✓ 11 | ✓ 9 | ✓ 19 | ✓ 9 | No history | No history |
| Paack | `534000021263149358` | [2026-08-04](https://web.archive.org/web/20260804120811/https://mydeliveries.paack.app/tracking/order?tracking_number=534000021263149358&postal_code=1958-001) | 2026-10-27 | ✓ 9 | No history | No history | No history | No history | N/A |
| Paack | `PK415000000000221343` | [2026-07-20](https://web.archive.org/web/20260720185840/https://mydeliveries.paack.app/tracking/order?postal_code=92400&tracking_number=PK415000000000221343&profile_mismatch=1) | 2026-10-27 | ✓ 8 | No history | ✓ 23 | No history | No history | N/A |
| Ecoscooting | `CNPRT19501971234009605248` | [2026-09-29](https://www.deco.proteste.pt/reclamar/todas-as-reclamacoes/falsa-entrega/70a3a590891f3a8160) | 2026-10-15 | ✓ 6 | ✓ 6 | ✓ 6 | ✓ 6 | Undated | N/A |
| Ecoscooting | `289700000110328320` | [2026-09-28](https://www.trustpilot.com/reviews/6aba48d1c0ccd119e8896bf1) | 2026-10-15 | ✓ 14 | No history | ✓ 13 | ✓ 14 | No history | N/A |
| GLS Spain | `1363341326` | [2026-10-15](https://web.archive.org/web/20261015112347/https://mygls.gls-spain.es/e/1363341326/36637) | 2026-10-27 | ✓ 5 | No history | No history | No history | No history | N/A |
| GLS Spain | `1361030847` | [2026-10-07](https://web.archive.org/web/20261007075846/https://mygls.gls-spain.es/e/1361030847/30520) | 2026-10-27 | ✓ 5 | No history | No history | No history | No history | N/A |
| InPost | `200000046672400966269614` | [2026-10-07](https://pl.trustpilot.com/reviews/6ac5fdcadc41c15304ea1acc) | 2026-10-15 | ✓ 20 | ✓ 19 | Postcode prompt | ✓ 21, partial (stops early) | No history | N/A |
| InPost | `200000033661600038871668` | [2026-10-07](https://pl.trustpilot.com/reviews/6ac5fdcadc41c15304ea1acc) | 2026-10-15 | ✓ 13 | ✓ 13 | Postcode prompt | ✓ 14 | No history | N/A |
| Poczta Polska | `CP265970733PL` | [2026-09-22](https://www.chinapostaltracking.com/qa/blocked-since-july-161167/) | 2026-10-15 | ✓ 5, partial (a third of the rows or fewer) | ✓ 10, partial (stops early) | ✓ 19 | ✓ 21 | Undated | ✓ 6 |
| Poczta Polska | `PX7678676761` | [2026-09-12](https://www.trustpilot.com/reviews/6aa57c3bf5ad63b0c0d968f3) | 2026-10-15 | ✓ 10 | ✓ 20 | ✓ 18 | ✓ 10 | ✓ 18 | N/A |
| DPD Poland | `13649547289291` | [2026-10-03](https://web.archive.org/web/20261003044720/https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=13649547289291) | 2026-10-15 | ✓ 8 | ✓ 1, partial (a third of the rows or fewer) | ✓ 12 | ✓ 8 | ✓ 5 | N/A |
| DPD Poland | `1050174241169U` | [2026-09-02](https://web.archive.org/web/20260902211513/https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=1050174241169U&p2=&p3=&p4=&p5=&p6=&p7=&p8=&p9=&p10=) | 2026-10-15 | ✓ 11 | No history | ✓ 11 | ✓ 11 | ✓ 11 | N/A |
| DHL eCommerce Poland | `30411776824` | [2026-08-14](https://pl.trustpilot.com/reviews/6a7e188f93d3f2755f36c638) | 2026-10-15 | ✓ 12 | ✓ 12 | No history | ✓ 12 | No history | N/A |
| DHL eCommerce Poland | `36570542917` | [2026-08-04](https://pl.trustpilot.com/reviews/6a7209a965171728817bef2d) | 2026-10-15 | ✓ 26 | No history | No history | ✓ 24 | No history | N/A |
| Packeta | `4651896715` | [2026-07-29](https://www.globkurier.pl/opinie-packeta) | 2026-10-15 | ✓ 3 | No history | No history | ✓ 3 | No history | N/A |
| Packeta | `Z3682567828` | [2026-07-02](https://www.globkurier.pl/opinie-packeta) | 2026-10-15 | ✓ 6 | ✓ 16, partial (undated rows) | No history | ✓ 10 | Undated | N/A |
| Nova Poshta (Ukraine) | `20451513915086` | [2026-08-21](https://www.vidhuk.ua/novaya-pochta-nova-poshta/review-2369305) | 2026-10-15 | ✓ 13 | No history | ✓ 26 | ✓ 13 | ✓ 13 | N/A |
| Nova Poshta (Ukraine) | `20451277260031` | [2025-11-08](https://www.vidhuk.ua/novaya-pochta-nova-poshta/review-2263481) | 2026-10-15 | No history | No history | No history | No history | No history | N/A |
| Ukrposhta | `CA315000362UA` | [2026-09-19](https://www.trustpilot.com/reviews/6aae6849e25391667cb34f4b) | 2026-10-15 | ✓ 22 | ✓ 30 | ✓ 33 | ✓ 45 | Undated | ✓ 11 |
| Ukrposhta | `0505683900154` | [2026-09-07](https://www.vidhuk.ua/uk/ukrposhta-ukrpochta/review-2374754) | 2026-10-15 | ✓ 14 | ✓ 14 | No history | ✓ 14 | No history | N/A |
| Speedy | `52096359735` | [2026-08-03](https://www.trustpilot.com/review/speedy.bg?sort=recency) | 2026-10-15 | ✓ 21 | No history | ✓ 21 | No history | No history | N/A |
| FAN Courier | `4164600013923` | [2026-06-15](https://www.trustpilot.com/reviews/6a2fe21bae6eb408dc6e3b26) | 2026-10-15 | ✓ 2 | No history | No history | No history | No history | N/A |
| Sameday | `1TMB2419700167` | [2026-07-24](https://www.trustpilot.com/review/sameday.ro?sort=recency) | 2026-10-15 | ✓ 16 | No history | No history | No history | Undated | N/A |
| Yurtiçi Kargo | `114011114595` | [2026-10-10](https://www.sikayetvar.com/yurtici-kargo/yurtici-kargo-inegol-subesinde-teslim-edilmeyen-kargolar-ve-yanlis-yonlendirme) | 2026-10-15 | ✓ 2 | No history | Postcode prompt | No history | No history | N/A |
| Yurtiçi Kargo | `191329680164` | [2026-10-10](https://www.sikayetvar.com/yurtici-kargo/yurtici-kargo-gultepe-subesi-15-yildir-teslim-edilmeyen-kargolar) | 2026-10-15 | ✓ 2 | No history | Postcode prompt | No history | No history | N/A |
| DHL Express | `7633033634` | [2026-09-16](https://www.trustpilot.com/reviews/6aaaf40b0ae5ece3b117fe62) | 2026-10-15 | ✓ 23 | ✓ 23 | ✓ 23 | ✓ 23 | Undated | N/A |
| DHL Express | `3408372365` | [2026-08-28](https://www.trustpilot.com/reviews/6a901943246975fa82db1390) | 2026-10-15 | ✓ 14 | ✓ 14 | No history | ✓ 14 | Undated | N/A |
| UPS | `1Z2231040309026972` | [2026-09-22](https://web.archive.org/web/20260922043823/https://www.ups.com/WebTracking?loc=en_US&requester=ST&trackNums=1Z2231040309026972) | 2026-10-15 | ✓ 16 | ✓ 16 | ✓ 16 | ✓ 16 | ✓ 16 | N/A |
| UPS | `1Z54V8630394427740` | [2026-09-18](https://www.trustpilot.com/reviews/6aad469800b96d1f86d26113) | 2026-10-15 | ✓ 7 | ✓ 7 | ✓ 7 | ✓ 7 | ✓ 7 | N/A |
| FedEx | `532981649667` | [2026-09-15](https://www.trustpilot.com/reviews/6aa95a1ed3a830f75a5b84e6) | 2026-10-15 | ✓ 7 | No history | ✓ 7 | No history | ✓ 7 | N/A |
| FedEx | `541270563758` | [2026-09-13](https://www.trustpilot.com/reviews/6aa6eaabc62ce509075349c1) | 2026-10-15 | ✓ 18 | No history | ✓ 18 | ✓ 18 | ✓ 18 | N/A |
| TNT | `1320002490250705` | [2026-07-24](https://www.trustpilot.com/reviews/6a636f2d0801a8c8be5d2c1b) | 2026-10-27 | No history | No history | No history | No history | No history | N/A |
| TNT | `1319298002846673` | [2026-07-16](https://www.trustpilot.com/reviews/6a58c1f15d75ae6cf50b8bf7) | 2026-10-27 | No history | No history | No history | No history | No history | N/A |
| EMS | `EB865157741CN` | [2026-09-16](https://www.chinapostaltracking.com/qa/package-stuck-export-customskeep-pending-inspection-161051/) | 2026-10-15 | ✓ 7, partial (a third of the rows or fewer) | Undated | ✓ 19 | ✓ 28 | Undated | ✓ 6 |
| EMS | `em595337205jp` | [2025-12-09](https://web.archive.org/web/20251209064703/https://items.ems.post/api/publicTracking/track?itemId=em595337205jp&language=EN) | 2026-10-15 | ✓ 9 | No history | ✓ 17 | ✓ 9 | No history | No history |
| AliExpress / Cainiao | `AP00821064969338` | [2026-08-27](https://www.trustpilot.com/reviews/6a7db425e965b756af79b6c0) | 2026-10-15 | ✓ 19 | No history | ✓ 19 | ✓ 19 | Undated | N/A |
| AliExpress / Cainiao | `AP00822511080252` | [2026-08-27](https://www.trustpilot.com/reviews/6a7db425e965b756af79b6c0) | 2026-10-15 | ✓ 24 | No history | ✓ 24 | ✓ 24 | Undated | N/A |
| China Post | `CP557517201CN` | [2026-10-05](https://www.chinapostaltracking.com/qa/cp557517201cn-161390/) | 2026-10-15 | ✓ 4, partial (a third of the rows or fewer) | ✓ 7, partial (a third of the rows or fewer, stops early) | ✓ 10 | ✓ 23 | Undated | ✓ 7 |
| China Post | `LZ464222669CN` | [2026-09-09](https://www.chinapostaltracking.com/qa/wanted-an-update-on-my-package-160844/) | 2026-10-15 | ✓ 4, partial (a third of the rows or fewer) | No history | ✓ 20 | ✓ 56 | Undated | ✓ 1 |
| Yanwen | `UL494089685YP` | [2026-09-18](https://web.archive.org/web/20260918150425/https://track.yw56.com.cn/en/querydel?nums=UL494089685YP) | 2026-10-15 | ✓ 19 | ✓ 19 | ✓ 24 | ✓ 19 | Undated | No history |
| Yanwen | `UL506640310YP` | [2026-09-15](https://web.archive.org/web/20260915200737/https://track.yw56.com.cn/en/querydel?nums=UL506640310YP&cyp=3e92842c2751e9d03164f2c2aa4b094e) | 2026-10-15 | ✓ 16 | ✓ 20 | ✓ 21 | ✓ 16 | Undated | No history |
| YunExpress | `YT2625900708886066` | [2026-09-30](https://web.archive.org/web/20260930131534/https://www.yuntrack.com/parcelTracking?id=YT2625900708886066) | 2026-10-15 | ✓ 24 | ✓ 31 | ✓ 24 | ✓ 25 | Undated | N/A |
| YunExpress | `YT2625700706267305` | [2026-09-30](https://web.archive.org/web/20260930131023/https://www.yuntrack.com/parcelTracking?id=YT2625700706267305) | 2026-10-15 | ✓ 25 | ✓ 33 | ✓ 21 | ✓ 26 | ✓ 33, partial (undated rows) | N/A |
| 4PX | `4PX3002790888841CN` | [2026-06-26](https://www.chinapostaltracking.com/qa/what-is-my-tracking-number-format-159483/) | 2026-10-15 | ✓ 26 | ✓ 25 | ✓ 26 | ✓ 26 | Undated | N/A |
| 4PX | `4PX3002555003946CN` | [2026-03-13](https://web.archive.org/web/20260313001028/https://track.4px.com/query/4PX3002555003946CN) | 2026-10-15 | ✓ 30 | No history | ✓ 30 | ✓ 44 | No history | N/A |
| CNE Express | `3A5V913107080` | [2026-08-03](https://web.archive.org/web/20260803094553/https://www.cne.com/en/track?no=3A5V913107080) | 2026-10-15 | ✓ 21 | ✓ 21, partial (undated rows, stops early) | No history | ✓ 20 | Undated | N/A |
| CNE Express | `3A5V640465958` | [2025-11-15](https://web.archive.org/web/20251115150544/https://www.cne.com/English/?no=3A5V640465958) | 2026-10-10 | ✓ 15, partial (undated rows) | No history | No history | ✓ 15 | No history | N/A |
| SpeedPAK | `ES1003113494686UN0101240600N` | [undated](https://community.ebay.com/forum/shipping-57923/topic/speedpak-any-know-who-is-delivering-them-in-the-us-now-158487/?focus_post=506934) | 2026-10-15 | ✓ 14 | No history | ✓ 14 | No history | No history | N/A |
| SunYou | `LP00061214526423` | [2023-04-06](https://leafeel.tistory.com/2) | 2026-10-15 | No history | No history | No history | No history | No history | N/A |
| SunYou | `SYAE006809461` | [2021-07-20](https://github.com/ha-parcel-integrations/ha-sunyou/blob/main/tests/payloads.py) | 2026-10-15 | ✓ 8 | No history | ✓ 8 | ✓ 8 | No history | N/A |
| SF Express | `SF6047789135544` | [2026-08-27](https://www.trustpilot.com/reviews/6a8f6e8514e24c45061779b6) | 2026-10-15 | ✓ 22 | No history | ✓ 26 | ✓ 27 | Undated | N/A |
| SF Express | `SF6047227701780` | [2026-01-16](https://www.trustpilot.com/reviews/696a4853722b4cb98b6e70ce) | 2026-10-15 | Error | No history | Error | No history | No history | N/A |
| JD Logistics | `JDJ002238017252` | [2025-11-29](https://web.archive.org/web/20251129093534/https://www.jdl.com/orderSearch/?waybillCodes=JDJ002238017252) | 2026-10-27 | Blocked | No history | No history | No history | No history | N/A |
| JD Logistics | `JDVA34246758676` | [2025-04-14](https://web.archive.org/web/20250414033943/https://www.jdl.com/orderSearch/?waybillCodes=JDVA34246758676) | 2026-10-27 | Error | No history | No history | No history | No history | N/A |
| YTO Express | `YT8879092508074` | [2026-06-20](https://www.ptt.cc/bbs/e-shopping/M.1781927397.A.39F.html) | 2026-10-15 | ✓ 30 | No history | ✓ 30 | No history | No history | N/A |
| USPS | `LS020782045US` | [2026-10-02](https://www.trustpilot.com/reviews/6abf5f856239213645935414) | 2026-10-15 | ✓ 18 | No history | ✓ 18 | ✓ 18 | Blocked | No history |
| USPS | `LH194723189US` | [2023-04-28](https://www.chinapostaltracking.com/qa/is-the-package-being-held-by-china-customs-15637/2/) | 2026-10-15 | Summary only | No history | Error | No history | Blocked | No history |
| OnTrac | `C12042142509047` | [2026-10-03](https://web.archive.org/web/20261003194516/https://www.ontrac.com/tracking/?number=C12042142509047) | 2026-10-15 | ✓ 7 | ✓ 7 | No history | ✓ 7 | ✓ 7 | N/A |
| OnTrac | `D10017744663378` | [2026-09-30](https://web.archive.org/web/20260930172042/https://www.ontrac.com/tracking/?number=D10017744663378) | 2026-10-15 | ✓ 7 | ✓ 7 | ✓ 7 | ✓ 7 | ✓ 7 | N/A |
| GOFO Express | `GFUS01075228958339` | [2026-10-01](https://web.archive.org/web/20261001232118/https://www.gofo.com/us/track?searchID=GFUS01075228958339) | 2026-10-15 | ✓ 12 | ✓ 12 | ✓ 27 | ✓ 12 | ✓ 35, partial (undated rows) | N/A |
| GOFO Express | `GFUS01074503026309` | [2026-09-27](https://web.archive.org/web/20260927185120/https://www.gofo.com/us/track?searchID=GFUS01074503026309) | 2026-10-15 | ✓ 8 | ✓ 8 | ✓ 21 | ✓ 8 | ✓ 8 | N/A |
| UniUni | `UUS69P8620998875588` | [2026-10-02](https://web.archive.org/web/20261002135332/https://www.uniuni.com/tracking/?no=UUS69P8620998875588) | 2026-10-15 | ✓ 11 | ✓ 11 | ✓ 11 | ✓ 11 | Undated | N/A |
| UniUni | `U000302706915066` | [2026-10-01](https://web.archive.org/web/20261001073755/https://www.uniuni.com/tracking/?no=U000302706915066) | 2026-10-15 | ✓ 5 | ✓ 5 | ✓ 5 | ✓ 5 | No history | N/A |
| Canada Post | `2010505799436494` | [2026-10-05](https://web.archive.org/web/20261005194842/https://www.canadapost-postescanada.ca/track-reperage/en/search?searchFor=2010505799436494) | 2026-10-15 | ✓ 12 | ✓ 2, partial (a third of the rows or fewer) | No history | ✓ 1, partial (a third of the rows or fewer, stops early) | No history | N/A |
| Canada Post | `LA586492541CA` | [2026-10-05](https://web.archive.org/web/20261005164912/https://www.canadapost-postescanada.ca/track-reperage/en/search?searchFor=LA586492541CA) | 2026-10-15 | ✓ 12 | ✓ 13, partial (undated rows, stops early) | ✓ 12 | ✓ 30 | Undated | ✓ 1 |
| Purolator | `520769802262` | [2026-09-28](https://www.trustpilot.com/review/www.purolator.com) | 2026-10-15 | ✓ 17 | ✓ 17 | No history | ✓ 17 | No history | N/A |
| Purolator | `EWN001815469` | [2026-09-12](https://www.trustpilot.com/reviews/6aa47d13e59cb2883d7ebb28) | 2026-10-15 | ✓ 12 | No history | ✓ 12 | ✓ 12 | No history | N/A |
| Intelcom / Dragonfly | `INTLCMJ099862529` | [2026-10-05](https://web.archive.org/web/20261005132028/https://dragonflyshipping.ca/en/track-your-package/?tracking-id=INTLCMJ099862529) | 2026-10-15 | ✓ 5 | ✓ 5 | ✓ 5 | ✓ 5 | ✓ 5 | N/A |
| Intelcom / Dragonfly | `SE260924QUM3` | [2026-09-25](https://web.archive.org/web/20260925173219/https://intelcom.ca/en/track-your-package/?tracking-id=SE260924QUM3) | 2026-10-15 | ✓ 6 | No history | ✓ 10 | ✓ 6 | No history | N/A |
| Australia Post | `LK286032428AU` | [2026-10-03](https://web.archive.org/web/20261003172322/https://auspost.com.au/mypost/track/details/LK286032428AU) | 2026-10-15 | ✓ 27 | ✓ 11 | ✓ 1, partial (a third of the rows or fewer, stops early) | No history | Undated | ✓ 1 |
| Australia Post | `99722999536301000830908` | [2026-10-02](https://web.archive.org/web/20261002002322/https://auspost.com.au/mypost/track/details/99722999536301000830908) | 2026-10-15 | ✓ 12 | No history | No history | No history | No history | N/A |
| NZ Post | `LX072774186NZ` | [2026-08-31](https://www.chinapostaltracking.com/qa/package-stuck-160626/) | 2026-10-15 | ✓ 16, partial (stops early) | ✓ 20, partial (undated rows, stops early) | ✓ 20, partial (stops early) | ✓ 28 | Undated | ✓ 4 |
| NZ Post | `EP559083729NZ` | [2026-01-07](https://www.chinapostaltracking.com/qa/parcel-not-delivered-yet-156048/) | 2026-10-15 | ✓ 29 | No history | ✓ 40 | ✓ 29 | No history | No history |
| Japan Post | `372-67-53094-1` | [2026-10-02](https://www.ktr.mlit.go.jp/ktr_content/content/000959754.pdf) | 2026-10-15 | ✓ 10 | No history | Postcode prompt | ✓ 4 | Undated | N/A |
| Japan Post | `152515917783` | [2026-09-02](https://web.archive.org/web/20260902182854/https://trackings.post.japanpost.jp/services/srv/search/direct?&reqCodeNo1=152515917783&locale=jp) | 2026-10-15 | ✓ 4 | No history | Postcode prompt | ✓ 4 | No history | N/A |
| Yamato Transport | `303142820352` | [2026-09-30](https://web.archive.org/web/20260930053322/https://member.kms.kuronekoyamato.co.jp/parcel/detail?pno=303142820352) | 2026-10-15 | ✓ 5, partial (undated rows) | No history | Postcode prompt | ✓ 5 | No history | N/A |
| Yamato Transport | `292803085481` | [2026-09-26](https://web.archive.org/web/20260926232440/https://member.kms.kuronekoyamato.co.jp/parcel/detail?pno=292803085481) | 2026-10-15 | ✓ 7, partial (undated rows) | No history | Postcode prompt | ✓ 7 | No history | N/A |
| Korea Post | `6892014190693` | [2026-09-29](https://web.archive.org/web/20260929154932/https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?sid1=6892014190693&displayHeader=N) | 2026-10-15 | ✓ 9 | No history | ✓ 9 | ✓ 9 | No history | N/A |
| Korea Post | `6097542557191` | [2026-09-24](https://kin.naver.com/qna/detail.naver?dirId=81302&docId=495290455) | 2026-10-15 | ✓ 10 | No history | No history | ✓ 10 | No history | N/A |
| Hongkong Post | `LP157079155HK` | [2026-06-20](https://detail.chiebukuro.yahoo.co.jp/qa/question_detail/q12329081017) | 2026-10-27 | Summary only | ✓ 32 | ✓ 34 | ✓ 17 | Undated | No history |
| Hongkong Post | `ZH755966962HK` | [2026-04-22](https://web.archive.org/web/20260422022709/https://global.cainiao.com/detail.htm?mailNoList=ZH755966962HK) | 2026-10-27 | No history | Error | No history | No history | No history | No history |
| Singapore Post | `CZ003411963SG` | [2026-09-04](https://www.chinapostaltracking.com/qa/cz003411963sg-pending-customs-declaration-materials-160765/) | 2026-10-15 | ✓ 7 | ✓ 4, partial (a third of the rows or fewer, stops early) | ✓ 4, partial (a third of the rows or fewer, stops early) | ✓ 18 | ✓ 11 | ✓ 4 |
| Singapore Post | `LT144740666SG` | [2026-09-01](https://www.chinapostaltracking.com/qa/item-lt144740666sg-held-by-the-customs-for-screening-160675/) | 2026-10-15 | ✓ 10, partial (a third of the rows or fewer) | ✓ 4, partial (a third of the rows or fewer, stops early) | ✓ 9, partial (a third of the rows or fewer, stops early) | ✓ 31 | ✓ 13, partial (stops early) | No history |
| India Post | `ED307210090IN` | [2026-08-15](https://www.trustpilot.com/reviews/6a8055756fed445cc4c4efc5) | 2026-10-15 | ✓ 27 | ✓ 27 | No history | ✓ 27 | No history | No history |
| India Post | `JM218901045IN` | [2025-10-07](https://ie.trustpilot.com/review/pvccardprinting.in) | 2026-10-15 | No history | No history | No history | No history | No history | No history |
| Delhivery | `28449706147373` | [2026-10-06](https://web.archive.org/web/20261006083725/https://www.delhivery.com/track-v2/package/28449706147373) | 2026-10-15 | ✓ 2 | No history | Postcode prompt | No history | No history | N/A |
| Delhivery | `9958110038695` | [2026-10-06](https://web.archive.org/web/20261006014444/https://www.delhivery.com/track-v2/package/9958110038695) | 2026-10-15 | ✓ 2 | No history | Postcode prompt | No history | No history | N/A |
| Correios Brazil | `NN376766183BR` | [2026-09-26](https://www.trustpilot.com/reviews/6ab708ba54e925ea877fb1b1) | 2026-10-15 | Error | No history | ✓ 3 | No history | Undated | No history |
| Correios Brazil | `AD803652820BR` | [2026-08-20](https://github.com/universidadedeterapias/meDIZ/pull/86) | 2026-10-15 | ✓ 8 | Undated | No history | ✓ 8 | Undated | No history |
| Aramex | `52594815954` | [2026-09-22](https://www.trustpilot.com/reviews/6ab224d5d826a3a9645a808f) | 2026-10-15 | ✓ 16 | No history | Postcode prompt | ✓ 16 | Undated | N/A |
| Aramex | `34913932303` | [2026-09-11](https://www.trustpilot.com/reviews/6aa34217e4eabf7830d01a11) | 2026-10-15 | ✓ 26 | ✓ 26 | ✓ 26 | ✓ 26 | Undated | N/A |
| J&T Express | `JY1592273075` | [2026-09-22](https://mediakonsumen.com/2026/09/22/surat-pembaca/paket-tiktok-shop-dengan-jt-express-tertahan-sejak-agustus-tanpa-kejelasan) | 2026-10-15 | ✓ 100 | No history | No history | No history | No history | N/A |
| J&T Express | `JD0587577815` | [2026-09-14](https://mediakonsumen.com/2026/09/14/surat-pembaca/dugaan-pencurian-dalam-pengiriman-jt-express-paket-disayat-isi-diambil-ditutup-lakban-ulang-dan-lepas-tangan) | 2026-10-15 | ✓ 17 | No history | No history | No history | No history | N/A |
| Ninja Van | `NLMYA71943214` | [2026-04-12](https://www.trustpilot.com/reviews/69db93b2876e4c3ccfc16628) | 2026-10-27 | Error | No history | No history | No history | No history | N/A |
| Ninja Van | `NLIDAP8003114210` | [2026-02-10](https://mediakonsumen.com/2026/02/10/surat-pembaca/21-pesanan-lazada-berisi-ponsel-hilang-dalam-pengiriman-karena-permainan-jasa-kirim-mengganti-isi-paket-dan-sampai-pembeli-tidak-sesuai) | 2026-10-27 | No history | No history | No history | No history | No history | N/A |
| The Courier Guy | `DD-KBA6JL` | [2026-09-14](https://www.hellopeter.com/the-courier-guy/reviews/no-collection-no-call-refusing-refund-dd-kba6jl-6597318) | 2026-10-15 | ✓ 14 | No history | Postcode prompt | No history | No history | N/A |
| The Courier Guy | `LD-2C7WLM` | [2026-09-10](https://www.hellopeter.com/the-courier-guy/reviews/courier-guy-is-the-worst-service-provider-6590204) | 2026-10-15 | ✓ 13 | No history | Postcode prompt | No history | No history | N/A |
<!-- /GENERATED:numbers -->
