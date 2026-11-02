# STO Express

Tracks Chinese domestic STO waybills through the trace behind STO's online customer-service
page. The shared request-signing label and salt are included, so no account, cookie or browser
is needed.

## How it works

The [online customer-service page](https://page.sto.cn/ued-projects/sto-customer-onlinekf),
linked from www.sto.cn as 在线咨询, looks a waybill up with one GET to
`https://customerservice-onlinemessageapi.sto.cn/interactive/getExternalTrace/{waybill}`. The
page's request hook adds three headers: `source`, a fixed label; `timestamp`, the time in
milliseconds; and `safeToken`, the hex MD5 of the label, the timestamp and a fixed salt. Both
constants are hardcoded in the page's public script and are the same for every visitor. The
adapter signs each request the same way. A missing or refused signature (`VERIFY_MISSING`,
`VERIFY_FAIL`) is a challenge, and so is an HTML page in place of the JSON reply.

The reply lists the waybill's scans, newest first. Every scan must name the requested
waybill, or the reply is rejected. The scan type picks the stage and the stored English
wording; a departure names the next facility when STO gives it. The location is the STO
facility that scanned the parcel, followed by its province and city. Scan types STO adds later
stay unmapped under their own label. `statusMap` in [status.ts](status.ts) answers the app's
review queue by scan type and the stored wording, on the way out and back.

Scales along the network record a weight on some scans; the newest one above zero is the
parcel's weight in kilograms.

## Non-obvious choices

The scan's `memo` text, the page's own description, names couriers and station keepers with
their phones, and gives collection addresses, pickup codes and delivery places. It is never
read. Neither are the courier, operator, signer, facility phone and facility code fields. The
description is built from the scan type and facility names alone.

Facility names abbreviate the province and city ("广东广州转运中心"), which the places lookup
cannot read, so the location adds the province and city fields STO sends with each scan.

Scan clocks are China wall clocks without an offset, read as `+08:00` times like the other
Chinese domestic carriers. An unreadable clock stays as provider text and never borrows an
older scan's time.

A scan type that mentions a return (退回, 退件) is filed as an exception that starts the trip
back to the sender. The later delivery, locker and station scans are on that trip, and a final
signature is a return rather than a delivery.

STO's website tracker (`site.sto.cn/Service/officialNet`) requires an Aliyun captcha. Its
only Android app, the merchant app `cn.sto.superMerchant`, tracks only for a signed-in
merchant. The customer-service trace is the anonymous route left. The same backend's
`queryOrderByBillCodeWeb` operation returns sender and recipient details and is not used.

## Limitations

An unknown waybill and an expired one get the same empty list, so tracking finds neither and
recognition calls both unknown. Twelve- and thirteen-digit waybills are older formats. Other
carriers' numbers share both detected lengths, so detection only suggests STO. Recognition asks
STO only about fifteen-digit `77` waybills: the twelve-digit numbers it was asked about were
other carriers'. A new salt or
label in STO's page stops lookups until the constants are updated.

## Testing

Set `STO_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/sto`. The suite also checks that well-formed unknown
fifteen- and twelve-digit waybills are not found.
