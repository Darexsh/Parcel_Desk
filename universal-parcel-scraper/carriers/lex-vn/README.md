# LEX Vietnam

LEX Vietnam parcels use enabled universal providers. There is no dedicated adapter.

LEX (Lazada eLogistics Express) is the Lazada marketplace's delivery network in Vietnam, run by Giao Hàng Flex
Speed. Its sites are logistics.lazada.vn and lex.vn. LEX Malaysia is a separate entry.

## Numbers

Buyers' comments on a Vietnamese coupon site show three layouts. Marketplace parcels carry `LMP`, ten digits and
`VNA`, which `lex-vn-1` suggests. LEX's own waybills carry `LEXST`, ten digits and `VN`, and returns `LEXRT`,
ten digits and `VNA`, which `lex-vn-2` suggests. Both rules are low: every example comes from one site, and the
tracker no longer finds them.

## Why there is no adapter

Its tracking page posts the numbers to an open JSON endpoint, `POST logistics.lazada.vn/api/search_packages`
with a `trackingNumbers` list, without a login or CAPTCHA, on the same platform as LEX Malaysia's. It answers
the public numbers and a made-up one alike with an empty list, so a found reply has not been seen and a missing
parcel cannot be told apart. LEX Indonesia's and LEX Malaysia's adapters use the same client
([lex.ts](../lex-id/lex.ts)); this site can join them once a found reply is seen.

## Links

The tracking page opens numbers from its `references` parameter, on both sites.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
