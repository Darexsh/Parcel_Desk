# WanbExpress

Tracks WanbExpress's own parcel identifiers through `tracking.wanbexpress.com`.
The tracker refuses plain requests with its verification code, so a lookup starts in a private
Playwright browser configured with `WANBEXPRESS_BROWSER_WS_ENDPOINT`, then the optional TRAWL
service. Only without either does it make the direct HTTP request. HTTP recognition makes the
direct request and never starts a browser. The direct request names a language: the tracker
fails with HTTP 500 on fetch's default `Accept-Language: *`.

The private browser opens the blank form and uses its advertised passive V3 verification.
Use a browser and network accepted by the carrier, with the SDK's exact `playwright-core`
peer version. Keep the capability endpoint private; the [Royal Mail browser service](../royal-mail/README.md)
can also serve this adapter. Each lookup has an isolated context and bounded deadline.

The scoped browser helper observes tracking responses before opening the blank form,
which can advertise passive V3 verification. If the carrier refuses V3, the helper opens
the public deep link for checkbox V2 within the remaining budget. When V2 is selected,
the helper fills the number and presses Track before using TRAWL's
reCAPTCHA solver. It waits for the carrier's `/Home/CaptchaVerify` callback and the page's
repeated tracking request: Google's acceptance alone does not complete the lookup. V3 runs
only while the public page advertises it. CAPTCHA tokens, cookies and the rendered page
stay in the isolated context; the adapter reads only bounded responses for the complete
requested identifier.
A final rejection remains a challenge even when an earlier reply succeeded.

The tracking reply must name the requested parcel and identify a parcel-ID match. Reference
and delivery-number matches stay inconclusive. Only the explicit unknown-parcel envelope is
not-found. Scans carry UTC instants; their display offsets are not applied a second time.
The last-mile partner's scans, iMile's on a parcel to Germany, come in the partner's sentences
and mostly without a code: they take the stage iMile's map gives those sentences.
Once WanbExpress has relabelled the parcel for its courier, the reply's metadata carries the
courier's number, which the tracker shows as `TrackingNo`, and the shipping service. The
tracker's last-mile panel names that service's courier from
`/Common/TrackLastMileCarrier?shippingServiceId=…&trackingNumber=…`, a plain request without
verification, which the adapter makes within the lookup's deadline after any retrieval path. The
courier is named only when the catalog knows it and its rules fit the number; without the
panel's answer the number stays unattributed.
Recipient details, proofs of delivery and photographs are excluded.

Verification depends on the browser and its network. A datacenter network can be rejected by
both reCAPTCHA flows; enabled universal providers then take over. An accepted CAPTCHA alone
never establishes that tracking succeeded.

Set `WANBEXPRESS_TRACKING_NUMBER` and either `WANBEXPRESS_BROWSER_WS_ENDPOINT` or
`FLARESOLVERR_URL` outside the repository and run
`npm run test:carriers:live -- carriers/wanbexpress/adapter.live.test.ts`.
