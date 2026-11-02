# HuaHan Logistics

Tracks HuaHan's own waybills through its public guest tracker. HuaHan carries parcels from
China to destination delivery partners.

## Retrieval

The [public form](https://www.hh-exp.cn/WebTrack/CargoTrack.html) opens verification through
`init.php`, reads a plain arithmetic question from `textcode.php`, and submits its answer to
`check.php`. After an explicit acceptance, the adapter posts one complete waybill to
`CargoTrackAction.php` in the same cookie session. Each lookup opens a fresh session and
shares one deadline across the four requests. No account, browser or external solver is needed.

The reply must repeat the requested waybill and confirm success. An explicit absence is
not found; verification failures, changed replies and an empty history remain distinct.
The adapter keeps the server's scan order, milestone codes, wording and locations. The
history runs from the order data in China through export, the flight and import clearance
to the destination carrier's scans.

- `Country_code` is the destination country. `Local_Carrier` and `Local_Number` name the
  destination carrier and its number. A suffix after an underscore (`_D104`) is not part of
  that number. The carrier is named only when the catalog knows it and its rules fit the
  number. The shipper's reference is omitted.
- Clocks have no offsets. After `Has been given to local carrier` (`JY`) the reply relays the
  destination carrier's scans on that carrier's clock, cut to the minute: a French history
  matched its partner's own tracker in French time. A destination country of one zone
  places those scans. HuaHan's own scans, in China and at the destination airport, stay
  local times.
- The reply can list a destination carrier's scan twice at the same minute: in that carrier's
  words at its place, and in HuaHan's generic words without one. The placed line stays, with
  the generic line's code when it came without one, so it keeps the code's stage.
- HuaHan's codes are two capitals. A tracking provider relays its scans in HuaHan's words
  under the provider's own codes, so the status map reads those scans by their words.

## Numbers

HuaHan waybills are `HHW`, two letters, ten digits and `YQ`. Its API documentation describes
that layout, which detection and the adapter accept. Postal and partner references are
outside this adapter's scope.

## Limitations

There is no cheap recognition flow: tracking requires a fresh verification exchange. Changed
challenge types remain a challenge and enabled universal providers can recover. Provider
history can supplement scans whose clocks cannot be placed on a timeline.

The customer API at `api.hh-exp.com/default/svc/web-service` needs account credentials;
it is separate from the anonymous web form.

## Testing

Set `HUAHAN_TRACKING_NUMBER` outside Git and run
`npm run test:carriers:live -- carriers/huahan`. `HUAHAN_UNKNOWN_NUMBER` checks explicit absence.
