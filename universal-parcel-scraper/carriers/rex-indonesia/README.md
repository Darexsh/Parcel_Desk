# REX Indonesia

The native adapter reads the [Indonesian guest tracking page](https://www.rex.co.id/id/tracking/)
with the complete waybill in `airwaybill`. It needs no session or CAPTCHA. The
consignment heading must match the whole requested number before milestones are read.
Older numeric waybills work when the caller selects REX; the existing detection rule
remains narrower.

The page supplies a milestone view, so native history remains partial and enabled
universal providers can supply a fuller scan log. Only dated milestones are retained;
blank template dates do not establish movement. Local clocks keep the printed minute
or day precision, with no asserted offset. Origin and destination labels alone do not
establish acceptance or arrival. Delivery labels omit the signatory, and the separate
sender, recipient and package details are discarded. HTTP failure diagnostics omit
the unprojected response body and private transport state.

An unknown waybill counts as not found only when the carrier's specific notice names
the same complete number. Changed pages, browser checks and empty histories retain
their own failure kinds. HTTP recognition reads the same public milestone view.

Run `npm run test:carriers:live -- carriers/rex-indonesia` with private
`REX_INDONESIA_TRACKING_NUMBER`, optionally `REX_INDONESIA_SECOND_TRACKING_NUMBER`
and `REX_INDONESIA_UNKNOWN_NUMBER`.
