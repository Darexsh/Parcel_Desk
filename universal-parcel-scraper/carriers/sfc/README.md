# SFC Service

SFC (Sendfromchina, 三态) is a Chinese cross-border e-commerce logistics company. It collects
sellers' parcels in China, flies them abroad and hands them to a postal or courier partner in
the destination country. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://www.sendfromchina.com/track/track/get-track-for-web` with the
   form body `tracknumber={number}`, as the tracking page sends it. It needs no cookie, token,
   key or browser. The JSON reply, served as `text/html`, holds the order and its scans, newest
   first. The tracker on `www.sfcservice.com` uses the same lookup.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- `{"count":0}` with the number echoed is the page's unknown-number answer. A 404 or a redirect
  is a moved route.
- Aliyun's firewall sits in front of the site. Its 403 or 405 block page, or its bot check in
  place of the reply, is a challenge.
- Recognition makes the same request.

## Notes

- The lookup also finds an order by its partner's number or the shop's reference, and reads the
  digit after `SFC` loosely: `SFC1` to `SFC5` with the same order code give the same order. The
  reply must echo the number asked, and the order counts only when its own order code, the
  number without `SFC` and the digit, or its AliExpress number is the number asked. A partner's
  number of ten to thirty digits counts when the order lists it as its own tracking number, so a
  reader who picks SFC for the number a shop gave can follow the order.
- A scan's `statu` is SFC's English wording, then the partner's own text in brackets. That text
  names the recipient and the courier and carries phone numbers, so only SFC's wording is kept,
  and phone numbers are removed from every line.
- The scan written as the parcel leaves SFC's warehouse names the courier that delivers it,
  that courier's number and its website. The number is the hand-off's number when the order's
  own partner number agrees. The courier is named only when the website or the name points to
  one catalog carrier whose rules take the number.
- The order's `track_status` sorts it into the page's tabs. Delivered, returned and waiting for
  collection are taken over the scans; the others, including in transit, which is also the
  page's default, are not.
- The expected flight departure and arrival are written before they happen and are no scans:
  the adapter drops them.
- The delivery notice SFC writes as the parcel leaves its warehouse names no step. SFC can write
  it again a second from the first; a notice within a minute after another at the same place
  counts once, at the earlier clock.
- Scans carry wall clocks with no zone: China's for SFC's legs and the destination's for the
  partner's, so they stay `local_time`.
- The shop's reference, the service, the weight, the sender's country and the proof of delivery
  in the reply are not kept.

## Limitations

- No delivery estimate, weight, or delivery time as an instant.
- Lettered partner numbers and shop references are not looked up. No rule names SFC for a
  partner's number of digits; other carriers' rules or none take it.
- J&T's name in the reply is the Chinese network's and its website J&T Mexico's home page, so
  the reply alone names no partner. Detection of the partner's number decides it.

## Numbers

SFC numbers are `SFC`, a digit, two letters and thirteen or fourteen digits, which `sfc-1`
claims. SFC gives AliExpress orders `SFC`, two letters, ten digits and `YQ`, which `sfc-ae`
claims; Kuaidi100's SFC page offers one as its example, and SFC's tracker answers it. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking form posts the numbers, so no address opens one parcel and no link is read.

## Testing

`SFC_TRACKING_NUMBER=... SFC_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/sfc`
