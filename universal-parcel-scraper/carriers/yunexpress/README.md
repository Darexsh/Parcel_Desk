# YunExpress

The adapter loads the official Yuntrack page and captures its tracking API
response. Plain HTTP is rejected by the site's request protection even with the
current public browser signature. The browser creates the request signature and
anonymous authorization header itself; the adapter retains no session material.
The local browser keeps ordinary resource loading because intercepted network
requests are rejected by the site's protection.

Configure a Chromium executable for local browser capture. When no local
executable is configured, the adapter can use a Trawl browser service that
includes the [Yuntrack capture hook](../../trawl/tracking-capture.mjs).
The hook checks the posted parcel and reads the browser's decoded API body.
Stock Trawl skips compressed bodies. Service capture is skipped when local
Chromium is configured.
An interactive verification remains a challenge and falls back to the providers.

The response's latest-event record supplies an offset for that exact scan.
Earlier scans often contain only local wall clocks, retained as `local_time`
in portal order. In France, when the reference is La Poste's, the scans
La Poste's sorting platforms relay ("Arrived at destination", "Handled by
local carrier", "Transport to delivery centre") come on UTC, newest or not:
the arrival La Poste dates 18:08:37+02:00 came as 16:08:37, and 14:21:33+01:00
in winter as 13:21:33. Read on Paris time, they showed twice beside La Poste's
own. The record states Paris's offset for them as well, but its delivery
office's scans keep the office's clock. Storage timezone fields never supply scan offsets. China's
rows name only the country, so a row without a place on China's leg, up to the
flight out, is dated on China's clock when the nearest row with a place, the
older one first, is in China: a departure given as the latest scan carries
+08:00, and read on the destination's clock the flight would land hours too
soon. The destination's leg, after the flight in or the whole history of a
parcel sent within its destination country, is dated on the latest scan's
stated offset when none of its rows names a place: one partner relays it,
and the carrier's home clock would be China's. With no flight in listed, the
leg follows the hand-over to the last-mile carrier ("Shipment is in transit
to carrier"): GOFO's own scans give the instants of the "In Transit" rows
after it on GOFO's wall clocks, half a day after China's reading. A history
that lists neither starts the leg at GOFO's first "Arrived at GOFO …" facility
scan. Some partners state their
zone's standard offset in summer too, and the leg then shares the latest
scan's error. Reading such a leg on the destination's zone, when the
destination has one zone and the stated offset is its standard one in summer
time, waits for a public sample: archived pages keep the page shell, not the
tracking reply.
[`identity.ts`](identity.ts) lets such a row take over the one an app
stored for its wall clock under another offset, with the same place and wording. The
reply is inconclusive when its latest summary does not match the first scan.
A shorter projection than the returned raw history is incomplete. An older row
with a place but no wording is skipped. Each row joins wording and place with
`----`; a dash given as the place is no place. A partner's place can give its
town twice ("MADRID, MADRID, ES"), which is read once, and the row takes over
the one an app stored with the repeat.

The downstream reference is retained for separate carrier confirmation. The
page's notes link to the last-mile carrier's site; that carrier becomes
`delivery_carrier` when the catalog knows the host and its own detection offers
the reference, because one brand's host can also serve regional networks the
catalog carrier does not cover. When the reply declares no reference, a
relayed row can link the partner's contact page with the partner's own
reference. That reference is the hand-off when the notes' carrier offers it,
else when detection gives it to one carrier alone and that carrier delivers in
the destination country. The feed relays the last-mile carrier's wording
without codes, so the status map also holds the partner lines seen there.

The reply carries a weight without a unit and with placeholder values for some
services, and estimate fields the page never shows, so neither is read. The
customer's order number is never read.

Scan stages come from [status.ts](status.ts), which compares Yuntrack's wording
without case or repeated spaces. A partner line that names a place or a reason,
such as a missed delivery's type or the depot a card left names, matches on its
fixed words. "Delivered to local carrier" is the hand-over
to the destination's last-mile carrier, so it stays in transit, as does a
courier partner's acceptance; only the latest event's delivered code marks a
delivery. A relayed notice, such as a reminder that failed to send, gets no
stage, and the scan before it gives the status. "Handed over to the courier"
follows DHL Parcel Netherlands, which files it as out for delivery.

After YunExpress hands a parcel to China Post, the feed relays China Post's
scans in Chinese. An arrival or a departure names its office in 【】 right
after the verb (`邮件到达【…】`, `邮件离开【…】，正在发往下一站`): the office
becomes the scan's place, in place of the city the feed gives, and leaves the
wording. An airline the feed gives as a place (邮政航空) is none, as in China
Post's own adapter. The scans show the English China Post's adapter gives its labels, and
stage as their Chinese. These scans are dated on China's clock wherever they happen: China Post
dates its own scans abroad on Beijing time, and the feed states +08:00 for its
arrival at the destination (到达寄达地). The destination post's own scans, from
its processing centre's arrival through import customs to the delivery, carry
that post's wall clock, as in China Post's adapter: they take the destination's
clock where it keeps one, else the scans around them date them. The latest-scan
record states China's offset for them too, so it is not read for them. A line with kana
or hangul is a partner's. Other clocks are dated on the feed's places first. [`identity.ts`](identity.ts)
lets such a row take over the one stored with the office in its wording, in
Chinese or at the airline.

Run `npm run test:carriers:live -- carriers/yunexpress` with a
configured browser. Set `YUNEXPRESS_TRACKING_NUMBER` outside the repository to
check a real parcel.
