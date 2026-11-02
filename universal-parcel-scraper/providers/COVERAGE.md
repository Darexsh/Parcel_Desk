# Carrier coverage by tracking source

Track123 is an opt-in public-page fallback for named FedEx lookups. Its response must identify FedEx and match the whole number. It runs before the existing providers when enabled; no coverage is inferred for other carriers. See [retrieval and limitations](track123/README.md).

[coverage.json](coverage.json) is the evidence provider order follows: what each provider
returned for references of a carrier. Most comparison references were private numbers, which
are not kept, so this table cannot be rerun as is. The README's figures come from
[the benchmark](../benchmark/README.md), which runs public numbers and keeps every answer;
its answers are references here too, noted "Benchmark number", which `npm run generate`
rewrites.
Provider results come from separate lookups on the same comparison reference;
unverified cells have no established result.
A direct sample names an alternative when that reference is outside the adapter's scope or
no longer available.

When replacing a comparison reference, rerun the adapter and every provider on the same
replacement. Keep other references as routing evidence. Adapter availability and successful
comparison lookups are separate counts.

The DHL references include Express shipments outside the dedicated DHL Paket adapter's
scope. Their public sources are in [the number corpus](../carriers/dhl/numbers.json).

OMGO is outside the comparison cohort. ParcelsApp returns OMGO history; the other
providers are unverified for it.

Emile is outside it too. ParcelsApp returns the history a consolidator relays for an Emile
number, Emile's scans included; Ship24 had none for the same references. UPU does not take
the format, and 17TRACK and Postal Ninja are unverified for it.

## Reading the table

A check mark means scan history came back. The number beside it counts projected rows,
partial histories included. Translations, repeated reports and postal exchange-office rows
can raise that count without adding progress. A summary alone, a challenge or a failed
identity check does not count as history. A negative on an expired reference says nothing
about current coverage. "Subscribers only" marks a carrier a provider keeps for its
subscribers: no anonymous lookup can answer, so routing leaves that provider out whatever it
returned before.

Postal Ninja's counts include scans with no zone. It places a scan on its service's clock
where that is established and otherwise borrows a zone as a guess
([Parsing](postal-ninja/README.md#parsing)), but many of its histories still have no scan a
consumer can place on a timeline. In a host's lookups its answers left no usable scan, so it
is asked after the other aggregators whatever its count, and about a carrier only when that
carrier's evidence shows its history.

<!-- GENERATED:coverage -->
| Carrier | Direct support | Direct sample | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [DHL](../carriers/dhl/README.md) | Yes | Blocked | ✓ 10 | ✓ 14 | No history | ✓ 14 | ✓ 1 |
| [DHL Express](../carriers/dhl-express/README.md) | Yes | ✓ 23 | ✓ 23 | ✓ 23 | Unverified | Unverified | N/A |
| [UPS](../carriers/ups/README.md) | Yes | ✓ 11 | Subscribers only | ✓ 11 | ✓ 11 | ✓ 11 | N/A |
| [FedEx](../carriers/fedex/README.md) | Yes | ✓ 14, intermittent | ✓ 14 | ✓ 14 | ✓ 14 | ✓ 14 | N/A |
| [USPS](../carriers/usps/README.md) | Yes | ✓ 11 | No history | No history | ✓ 11 | No history | N/A |
| [Amazon Logistics](../carriers/amazon-logistics/README.md) | Link only | Not tested | No history | Sign-in | No history | No history | N/A |
| [Amazon Shipping](../carriers/amazon-shipping/README.md) | Yes | ✓ 12 | ✓ 12 | ✓ 12 | No history | ✓ 12 | N/A |
| [Royal Mail](../carriers/royal-mail/README.md) | Yes (local Chromium) | ✓ 8 | Subscribers only | ✓ 1 | No history | ✓ 4 | No history |
| [Swiss Post](../carriers/swiss-post/README.md) | Yes | ✓ 8 | ✓ 8 | ✓ 8 | ✓ 8 | No history | N/A |
| [La Poste / Colissimo](../carriers/la-poste/README.md) | Yes | ✓ 15 | ✓ 11, partial | ✓ 16 | ✓ 14 | ✓ 26 | No history |
| [DPD Switzerland](../carriers/dpd/README.md) | Yes (Switzerland; optional postcode) | ✓ 4 | ✓ 1, partial | ✓ 4 | ✓ 4 | ✓ 4 | N/A |
| [DHL eCommerce](../carriers/dhl-ecommerce/README.md) | Yes | ✓ 16 | ✓ 11, partial | ✓ 36 | No history | ✓ 34 | N/A |
| [AliExpress / Cainiao](../carriers/aliexpress/README.md) | Yes | ✓ 17 | No history | ✓ 17 | ✓ 17 | ✓ 17 | N/A |
| [China Post](../carriers/china-post/README.md) | Yes (newest three scans) | Unverified; alternate ✓ 4, partial | ✓ 1, partial | ✓ 1, partial | ✓ 39 | ✓ 17 | ✓ 1 |
| [EMS](../carriers/ems/README.md) | Yes | ✓ 7 | ✓ 6 | ✓ 18 | ✓ 24 | ✓ 6 | ✓ 6 |
| [SF Express](../carriers/sf-express/README.md) | Yes | ✓ 22 | Subscribers only | No history | ✓ 27 | No history | N/A |
| [GLS Germany](../carriers/gls-de/README.md) | Yes (postcode) | Not tested (postcode) | No history | No history | No history | No history | N/A |
| [GLS France](../carriers/gls-fr/README.md) | Yes | No history | No history | ✓ 4 | No history | No history | N/A |
| [GLS Switzerland](../carriers/gls-ch/README.md) | Yes (postcode) | Unverified | Unverified | Unverified | Unverified | Unverified | N/A |
| [Hermes Germany](../carriers/hermes-de/README.md) | Yes | No history | No history | No history | No history | No history | N/A |
| [Evri](../carriers/evri/README.md) | Yes (international) | ✓ 20 | No history | ✓ 21 | No history | No history | N/A |
| [Chronopost](../carriers/chronopost/README.md) | Yes (via La Poste) | No history | No history | No history | No history | No history | No history |
| [Mondial Relay](../carriers/mondial-relay/README.md) | Yes (postcode for short numbers) | No history | No history | No history | No history | No history | N/A |
| [InPost](../carriers/inpost/README.md) | Yes | ✓ 9 | ✓ 9 | ✓ 9 | ✓ 8 | No history | N/A |
| [PostNL](../carriers/spring-gds/README.md) | Yes | ✓ 16 | ✓ 16 | No history | No history | ✓ 16, partial | No history |
| [Canada Post](../carriers/canada-post/README.md) | Yes | No history; alternate ✓ 11 | ✓ 12 | ✓ 11 | ✓ 25 | Error | ✓ 1 |
| [Australia Post](../carriers/australia-post/README.md) | Yes | ✓ 12 | No history | No history | No history | ✓ 12, partial | N/A |
| [Japan Post](../carriers/japan-post/README.md) | Yes | ✓ 13 | ✓ 13, partial | ✓ 27 | ✓ 27 | ✓ 28, partial | ✓ 1 |
| [India Post](../carriers/india-post/README.md) | Yes | ✓ 21 | ✓ 21, partial | No history | ✓ 21 | No history | No history |
| [Poste Italiane](../carriers/poste-italiane/README.md) | Yes | No history | No history | No history | No history | No history | N/A |
| [Correos Spain](../carriers/correos-spain/README.md) | Yes | ✓ 12 | Error | ✓ 12, partial | ✓ 12 | No history | N/A |
| [bpost](../carriers/bpost/README.md) | Yes | ✓ 11 | No history | Postcode prompt | No history | No history | N/A |
| [Austrian Post](../carriers/austrian-post/README.md) | Yes | ✓ 9 | ✓ 9, partial | ✓ 9 | ✓ 9 | ✓ 9 | N/A |
| [PostNord](../carriers/postnord/README.md) | Yes | ✓ 6 | ✓ 6, partial | ✓ 6 | ✓ 6 | ✓ 7 | No history |
| [TNT](../carriers/tnt/README.md) | Yes | No history; alternate ✓ 1 | No history | No history | No history | No history | N/A |
| [Aramex](../carriers/aramex/README.md) | Yes | ✓ 16 | No history | No history | No history | ✓ 16 | N/A |
| [YunExpress](../carriers/yunexpress/README.md) | Yes (browser) | ✓ 23 | ✓ 14 | ✓ 15 | ✓ 14 | ✓ 15 | N/A |
| [4PX](../carriers/four-px/README.md) | Yes | ✓ 26 | ✓ 25 | ✓ 26 | ✓ 26 | ✓ 26 | N/A |
| [Yanwen](../carriers/yanwen/README.md) | Yes | ✓ 29 | ✓ 1, partial | ✓ 29 | ✓ 29 | No history | No history |
| [J&T Express](../carriers/j-and-t/README.md) | Yes (Indonesia) | Out of scope (Philippines); alternate ✓ 11 | No history | No history | No history | No history | N/A |
| [JD Logistics](../carriers/jd-logistics/README.md) | Yes (international) | Unverified | Unverified | Unverified | Unverified | Refused | N/A |
| [ZTO Express](../carriers/zto/README.md) | Yes (browser; partial history) | Not tested | Unverified | Unverified | Unverified | Unverified | N/A |
| [YTO Express](../carriers/yto/README.md) | Yes (China domestic) | ✓ 30 | Error | ✓ 30 | ✓ 20 | No history | N/A |
| [Yunda Express](../carriers/yunda/README.md) | Yes (China domestic) | Unverified; alternate ✓ 2 | Unverified | Unverified | Unverified | Unverified | N/A |
| [STO Express](../carriers/sto/README.md) | Yes (China domestic) | Unverified; alternate ✓ 11 | Unverified | Unverified | Unverified | Unverified | N/A |
| [Yamato Transport](../carriers/yamato/README.md) | Yes | ✓ 7 (yearless dates) | Error | Wrong carrier | No history | No history | N/A |
| [Correios Brazil](../carriers/correios-br/README.md) | Yes (local OCR) | ✓ 8 | ✓ 8 | No history | ✓ 8 | Error | No history |
| [Singapore Post](../carriers/singapore-post/README.md) | Yes | ✓ 9 | ✓ 4, partial | ✓ 12 | ✓ 18 | ✓ 11 | ✓ 4 |
| [Hongkong Post](../carriers/hongkong-post/README.md) | Yes (latest status) | Unverified; alternate summary only | ✓ 26 | ✓ 35 | ✓ 17, partial | ✓ 35 | No history |
| [Korea Post](../carriers/korea-post/README.md) | Yes (international) | ✓ 20 | ✓ 36 | ✓ 41 | ✓ 28 | ✓ 27 | ✓ 1 |
| [Planzer](../carriers/planzer/README.md) | Yes | ✓ 4 | No history | No history | No history | No history | N/A |
| [Quickpac](../carriers/quickpac/README.md) | Yes (via Planzer) | No history | No history | No history | No history | No history | N/A |
| [DPD France](../carriers/dpd-fr/README.md) | Yes | ✓ 10 | ✓ 10, partial | ✓ 5, partial | No history | No history | N/A |
| [Parcelforce Worldwide](../carriers/parcelforce/README.md) | Yes (via Royal Mail; local Chromium) | Not tested | No history | No history | No history | ✓ 3 | No history |
| [Purolator](../carriers/purolator/README.md) | Yes | ✓ 12, intermittent | No history | ✓ 12 | ✓ 12 | Refused | N/A |
| [OnTrac](../carriers/ontrac/README.md) | Yes | ✓ 14 | No history | ✓ 14 | No history | ✓ 14 | N/A |
| [Delhivery](../carriers/delhivery/README.md) | Yes | ✓ 2, partial (one undated scan and a status snapshot) | No history | No history | No history | No history | N/A |
| [Blue Dart](../carriers/blue-dart/README.md) | Yes | ✓ 15 | No history | No history | No history | No history | N/A |
| [DTDC](../carriers/dtdc/README.md) | Yes | ✓ 9 | No history | ✓ 37 | No history | No history | N/A |
| [Ninja Van](../carriers/ninja-van/README.md) | Yes (Malaysia NLMY) | No history; alternate ✓ 5 | No history | No history | No history | No history | N/A |
| [Packeta](../carriers/packeta/README.md) | Yes | ✓ 6 | ✓ 11 | No history | No history | ✓ 12 | N/A |
| [Poczta Polska](../carriers/poczta-polska/README.md) | Yes | ✓ 5 | ✓ 10 | ✓ 19 | ✓ 21 | ✓ 18 | ✓ 6 |
| [Bring](../carriers/bring-posten/README.md) | Yes | ✓ 12 | ✓ 12 | ✓ 15 | ✓ 19 | ✓ 16 | ✓ 3 |
| [Posti](../carriers/posti/README.md) | Yes | Unverified | Unverified | Unverified | Unverified | Unverified | N/A |
| [An Post](../carriers/an-post/README.md) | Yes (Irish S10 numbers) | Unverified; alternate ✓ 13 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | No history |
| [CTT Portugal](../carriers/ctt/README.md) | Yes | ✓ 4 | ✓ 4 | ✓ 5 | ✓ 5 | ✓ 3 | ✓ 2 |
| [CTT Express](../carriers/ctt-express/README.md) | Yes | ✓ 5 | ✓ 5 | ✓ 5 | ✓ 4 | ✓ 6 | N/A |
| [BRT](../carriers/brt/README.md) | Yes | ✓ 9 | No history | ✓ 23 | No history | ✓ 5 | N/A |
| [SEUR](../carriers/seur/README.md) | Yes | No history; alternate ✓ 6 | No history | ✓ 4 | ✓ 4 | ✓ 4 | N/A |
| [Correos Express](../carriers/correos-express/README.md) | Yes | ✓ 9 | ✓ 9 | ✓ 9 | No history | No history | N/A |
| [MRW](../carriers/mrw/README.md) | Yes | ✓ 14 | ✓ 14 | ✓ 14 | No history | ✓ 14 | N/A |
| [NACEX](../carriers/nacex/README.md) | Yes | ✓ 13 | Refused | Refused | Refused | Refused | N/A |
| [Colis Privé](../carriers/colis-prive/README.md) | Yes (postcode) | Not tested (postcode) | No history | No history | No history | No history | N/A |
| [Relais Colis](../carriers/relais-colis/README.md) | Yes | ✓ 4 | No history | ✓ 4 | No history | Refused | N/A |
| [Paack](../carriers/paack/README.md) | Yes (postcode; PK numbers via Evri) | Not tested (postcode) | No history | No history | No history | No history | N/A |
| [Asendia](../carriers/asendia/README.md) | Yes (Asendia USA and UK) | ✓ 5 | ✓ 2, partial | ✓ 6 | Error | ✓ 3, partial | ✓ 2 |
| [Landmark Global](../carriers/landmark-global/README.md) | Yes | ✓ 14 | ✓ 14 | ✓ 21 | No history | ✓ 21 | N/A |
| [NZ Post](../carriers/nz-post/README.md) | Yes | ✓ 16 | ✓ 20 | ✓ 20 | ✓ 16 | ✓ 20 | ✓ 4 |
| [Pos Malaysia](../carriers/pos-malaysia/README.md) | Yes | ✓ 2 | Error | ✓ 2 | ✓ 2 | No history | No history |
| [Thailand Post](../carriers/thailand-post/README.md) | Yes | ✓ 8 | ✓ 8 | ✓ 8 | No history | ✓ 8 | No history |
| [Ukrposhta](../carriers/ukrposhta/README.md) | Yes | ✓ 22; alternate ✓ 14 | ✓ 30 | ✓ 33 | ✓ 45 | ✓ 33 | Error |
| [Estafeta](../carriers/estafeta/README.md) | Yes | ✓ 4 | No history | No history | No history | No history | N/A |
| [Correos de Chile](../carriers/correos-chile/README.md) | Yes | No history; alternate ✓ 1 | No history | No history | ✓ 13 | No history | No history |
| [The Courier Guy](../carriers/the-courier-guy/README.md) | Yes | ✓ 14; alternate ✓ 13 | No history | No history | No history | Refused | N/A |
| [GEODIS](../carriers/geodis/README.md) | Yes | Summary only | No history | Postcode prompt | ✓ 4, partial | ✓ 2 | N/A |
| [Dachser](../carriers/dachser/README.md) | Yes (tracking link) | Not tested (link) | No history | No history | No history | No history | N/A |
| [Old Dominion](../carriers/old-dominion/README.md) | Yes (local Chromium) | Unverified; alternate ✓ 18, intermittent | Unverified | Unverified | Unverified | Unverified | N/A |
| [Swiss Post Cargo](../carriers/swiss-post-cargo/README.md) | Yes | Unverified | Unverified | Unverified | Unverified | Unverified | N/A |
| [PostLogistics](../carriers/postlogistics/README.md) | Yes | Unverified | Unverified | Unverified | Unverified | Unverified | N/A |
| [Hermes Einrichtungs-Service](../carriers/hermes/README.md) | Yes | ✓ 10 | No history | No history | No history | No history | N/A |
| [Heppner](../carriers/heppner/README.md) | Yes (postcode) | Not tested (postcode) | No history | Wrong carrier | No history | Refused | N/A |
| [Ciblex](../carriers/ciblex/README.md) | Yes | ✓ 7 | No history | Postcode prompt | No history | No history | N/A |
| [C Chez Vous](../carriers/c-chez-vous/README.md) | Yes | No history | No history | No history | No history | Refused | N/A |
| [Colisweb](../carriers/colisweb/README.md) | Yes | ✓ 2 | Wrong carrier | No history | No history | Refused | N/A |
| [Delivengo](../carriers/delivengo/README.md) | Yes (via La Poste) | No history | No history | No history | No history | No history | No history |
| [UniUni](../carriers/uniuni/README.md) | Yes | ✓ 6 | ✓ 6 | ✓ 19 | ✓ 6 | ✓ 21 | N/A |
| [SpeedX](../carriers/speedx/README.md) | Yes | ✓ 2 | No history | No history | ✓ 2 | No history | N/A |
| [GOFO Express](../carriers/gofo/README.md) | Yes | ✓ 14 | ✓ 14 | ✓ 14 | ✓ 14 | ✓ 14 | N/A |
| [Ecoscooting](../carriers/ecoscooting/README.md) | Yes | ✓ 6 | ✓ 6, partial | ✓ 6, partial | No history | ✓ 22 | N/A |
| [TIPSA](../carriers/tipsa/README.md) | Yes | ✓ 13 | No history | ✓ 13 | No history | No history | N/A |
| [Canpar](../carriers/canpar/README.md) | Yes | ✓ 11 | No history | ✓ 11 | No history | ✓ 11 | N/A |
| [DPD Germany](../carriers/dpd-de/README.md) | Yes (Germany; optional postcode) | ✓ 4 | Unverified | Unverified | Unverified | Unverified | N/A |
| [DPD UK](../carriers/dpd-uk/README.md) | Yes (UK parcel numbers) | ✓ 7 | Unverified | Unverified | Unverified | Unverified | N/A |
| [Evri UK](../carriers/evri-uk/README.md) | Yes (local Chromium) | ✓ 6 | Unverified | Unverified | Unverified | Unverified | N/A |
| [SpeedPAK](../carriers/speedpak/README.md) | Yes | ✓ 14 | Unverified | Unverified | Unverified | Unverified | N/A |
| [Intelcom / Dragonfly](../carriers/intelcom/README.md) | Yes (Canada) | Not found; alternate ✓ 6 | Unverified | Unverified | Unverified | Unverified | N/A |
| [Ekart](../carriers/ekart/README.md) | Yes (ecommerce) | ✓ 1 | Unverified | Unverified | Unverified | Unverified | N/A |
| [Xpressbees](../carriers/xpressbees/README.md) | Yes (seller-platform AWBs) | Alternative ✓ 42 | Unverified | Unverified | Unverified | Unverified | N/A |
| [LBC Express](../carriers/lbc-express/README.md) | Yes (local Chromium) | Unverified; alternate ✓ 6 | Unverified | Unverified | Unverified | Unverified | N/A |
| [Nova Poshta (Ukraine)](../carriers/nova-poshta/README.md) | Yes (Ukraine) | ✓ 10 | Unverified | Unverified | Unverified | Unverified | N/A |
| [SPX Express Philippines](../carriers/spx-ph/README.md) | Yes (Philippines) | ✓ 10 | Unverified | Unverified | Unverified | Unverified | N/A |
| [CNE Express](../carriers/cne/README.md) | Yes | ✓ 9 | Unverified | Unverified | Unverified | Unverified | N/A |
| [Sagawa Express](../carriers/sagawa/README.md) | Yes (status only) | Unverified; alternate summary only | Unverified | Unverified | Unverified | Unverified | N/A |
| [Spee-Dee](../carriers/spee-dee/README.md) | Yes | Unverified; alternate ✓ 5 | Unverified | Unverified | Unverified | Unverified | N/A |
| [GOFO France](../carriers/gofo-fr/README.md) | Yes | ✓ 7 | No history | No history | No history | No history | N/A |
| [DHL eCommerce UK](../carriers/dhl-ecommerce-uk/README.md) | Yes | ✓ 4 | ✓ 4 | No history | ✓ 4 | No history | N/A |
| [DHL eCommerce Netherlands](../carriers/dhl-ecommerce-nl/README.md) | Yes | ✓ 50 | ✓ 39 | ✓ 50 | ✓ 49 | ✓ 49 | N/A |
| [DHL eCommerce Iberia](../carriers/dhl-ecommerce-es/README.md) | Yes | ✓ 10, partial | ✓ 11 | ✓ 20 | ✓ 11 | No history | No history |
| [DPD Poland](../carriers/dpd-pl/README.md) | Yes | ✓ 8, partial | ✓ 1, partial | ✓ 12 | ✓ 8 | ✓ 5 | N/A |
| [DHL eCommerce Poland](../carriers/dhl-ecommerce-pl/README.md) | Yes | Summary only | ✓ 12 | No history | ✓ 12 | No history | N/A |
| [SunYou](../carriers/sunyou/README.md) | Yes | No history | No history | No history | No history | No history | N/A |
| [Omniva](../carriers/omniva/README.md) | Yes | No adapter | ✓ 1 | ✓ 1 | No history | Undated | No history |
| [GLS Italy](../carriers/gls-it/README.md) | Yes | No adapter | ✓ 10 | ✓ 11 | ✓ 11 | No history | N/A |
| [GLS Spain](../carriers/gls-es/README.md) | Yes | No adapter | No history | No history | No history | No history | N/A |
| [Speedy](../carriers/speedy/README.md) | Yes | No adapter | No history | ✓ 21 | No history | No history | N/A |
| [FAN Courier](../carriers/fan-courier/README.md) | Yes | No adapter | No history | No history | No history | No history | N/A |
| [Sameday](../carriers/sameday/README.md) | Yes | No adapter | No history | No history | No history | Undated | N/A |
| [Yurtiçi Kargo](../carriers/yurtici-kargo/README.md) | Yes | ✓ 2 | No history | Postcode prompt | No history | No history | N/A |
<!-- /GENERATED:coverage -->

<!-- GENERATED:lookup-order -->
| Source | Carriers with history | Full | Partial | Only source |
| --- | ---: | ---: | ---: | ---: |
| Ship24 | 62 | 24 | 38 | 0 |
| ParcelsApp | 80 | 52 | 28 | 6 |
| 17TRACK | 76 | 49 | 27 | 4 |
| Postal Ninja | 58 | 19 | 39 | 0 |

With Postal Ninja enabled, a number no carrier is named for uses ParcelsApp → Ship24 → 17TRACK → Postal Ninja. A carrier without its own order uses ParcelsApp → Ship24 → 17TRACK. These carriers have their own:

| Carrier | Order |
| --- | --- |
| DHL | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| DHL Express | Ship24 → 17TRACK → ParcelsApp |
| UPS | ParcelsApp → 17TRACK → Postal Ninja |
| FedEx | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| USPS | 17TRACK → ParcelsApp → Ship24 |
| Amazon Shipping | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| Royal Mail | ParcelsApp → 17TRACK → Postal Ninja |
| Swiss Post | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| La Poste / Colissimo | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| DPD Switzerland | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| DHL eCommerce | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| AliExpress / Cainiao | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| China Post | 17TRACK → ParcelsApp → Ship24 → Postal Ninja |
| EMS | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| SF Express | 17TRACK → ParcelsApp |
| GLS Germany | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| GLS France | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| Hermes Germany | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| Chronopost | 17TRACK → ParcelsApp → Ship24 |
| InPost | Ship24 → ParcelsApp → 17TRACK |
| PostNL | Ship24 → ParcelsApp → 17TRACK → Postal Ninja |
| Australia Post | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| Japan Post | 17TRACK → ParcelsApp → Ship24 → Postal Ninja |
| India Post | 17TRACK → Ship24 → ParcelsApp |
| Poste Italiane | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| Correos Spain | 17TRACK → ParcelsApp → Ship24 → Postal Ninja |
| bpost | 17TRACK → ParcelsApp → Ship24 |
| Austrian Post | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| PostNord | 17TRACK → ParcelsApp → Ship24 → Postal Ninja |
| Aramex | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| YunExpress | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| 4PX | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| Yanwen | ParcelsApp → 17TRACK → Ship24 |
| YTO Express | ParcelsApp → 17TRACK → Ship24 |
| Yamato Transport | 17TRACK → Ship24 |
| Correios Brazil | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| Singapore Post | 17TRACK → ParcelsApp → Ship24 → Postal Ninja |
| Hongkong Post | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| Korea Post | 17TRACK → ParcelsApp → Ship24 → Postal Ninja |
| Planzer | 17TRACK → ParcelsApp → Ship24 |
| Parcelforce Worldwide | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| Purolator | 17TRACK → ParcelsApp → Ship24 |
| OnTrac | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| Packeta | Ship24 → 17TRACK → ParcelsApp → Postal Ninja |
| Poczta Polska | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| Bring | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| An Post | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| CTT Portugal | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| CTT Express | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| BRT | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| SEUR | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| MRW | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| Relais Colis | ParcelsApp → 17TRACK → Ship24 |
| Asendia | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| Landmark Global | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| NZ Post | 17TRACK → ParcelsApp → Ship24 → Postal Ninja |
| Pos Malaysia | ParcelsApp → 17TRACK → Ship24 |
| Thailand Post | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| Ukrposhta | Ship24 → 17TRACK → ParcelsApp → Postal Ninja |
| Correos de Chile | 17TRACK → ParcelsApp → Ship24 |
| GEODIS | 17TRACK → ParcelsApp → Ship24 → Postal Ninja |
| Heppner | Ship24 → 17TRACK |
| Colisweb | ParcelsApp → 17TRACK |
| UniUni | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| SpeedX | 17TRACK → ParcelsApp → Ship24 |
| GOFO Express | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| Ecoscooting | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| Canpar | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| DPD Germany | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| DPD UK | Ship24 → ParcelsApp → 17TRACK → Postal Ninja |
| Intelcom / Dragonfly | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| Nova Poshta (Ukraine) | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| CNE Express | 17TRACK → Ship24 → ParcelsApp |
| GOFO France | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| DHL eCommerce UK | Ship24 → 17TRACK → ParcelsApp |
| DHL eCommerce Netherlands | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| DPD Poland | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| DHL eCommerce Poland | 17TRACK → Ship24 → ParcelsApp |
| SunYou | ParcelsApp → 17TRACK → Ship24 |
| GLS Italy | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
<!-- /GENERATED:lookup-order -->

## Retrieval limits

The catalog declares supported inputs and routes. Some anonymous trackers require a postcode,
capability URL, browser service or interactive verification. Dedicated adapters reject
unbound replies, wrong parcel identities and ambiguous multi-piece shipments. Unresolved
scan clocks remain local. See each [carrier README](../carriers/) for its scope and constraints.

## Method

[scripts/coverage-probe.mjs](../scripts/coverage-probe.mjs) runs adapters and providers independently
with bounded deadlines. Keep its input references outside the repository. Review grades before
writing coverage.json, including partial history, stale references, wrong carrier and refused
formats. Extra references inform provider ordering but are not averaged into the README's
comparison. Run `npm run generate` to update the tables and summary.

Juxi Express tries Track718 first, retaining ParcelsApp, Ship24 and 17TRACK as fallbacks.
Track718 is enabled only for Juxi and remains opt-in; this policy does not grade its history
as fuller than another provider's. Its [README](track718/README.md) describes the guest flow.
