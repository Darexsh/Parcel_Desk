# JANCO Express

JANCO Express parcels use enabled universal providers. There is no dedicated adapter.

JANCO Express (Janco Express Limited, 駿高速運) is a Hong Kong courier in the Janco group. It runs its own courier
lanes from Hong Kong to Bangladesh, Cambodia, India, Myanmar, Pakistan, Sri Lanka and Vietnam, and from South and
East China to Bangladesh, and brings parcels into Hong Kong from Korea, India and Bangladesh. Its site is
jancoexpress.com. JANCO eCommerce, a sister company in the group, keeps its own orders on a separate tracker
and is not covered here.

## Numbers

Its order numbers are `JE`, two letters and eight digits in the one public example, from its own API manual,
which its tracker still finds. `janco-express-1` suggests that layout at low confidence, since one example is
all there is. The manual allows order numbers of up to twenty characters; the rule covers only the layout seen.
It leaves out a Z as the fourth character, which is StarTrack's consignment layout.

## Why there is no adapter

Its tracking page reads an open JSON endpoint without a session or CAPTCHA:
`POST track.jancoexpress.com/cargotracking_xp/api/itcommon/general_sql` with the form fields `query_name`, set to
`iteleo_sql\d_sp_iteleo_single_cargo_track`, and `query_json`, holding `as_tracking_type` `XPORDER` and the
number in `as_tracking_no`. It answers an unknown number with an empty list, and the public example with its
booking, route, weights and the number of the co-loader that carries a leg. Milestones come as an XML string
inside the JSON row, and the booking date carries no zone. JANCO eCommerce runs a separate tenant of the same
platform under track.jancoecommerce.com, which does not know JANCO Express orders. The B2B API its manual
documents needs an account. No adapter has been written for it yet.

## Links

The tracking page opens numbers from its `as_order_no` parameter, which takes several separated by semicolons.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
