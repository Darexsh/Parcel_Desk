# Instabox

Tracks a parcel through the recipient's complete notification link on `track.instabox.com`.
The link's verification code is an optional tracking-URL input; without it, enabled universal
providers are asked. No phone number, email address, account or CAPTCHA is submitted.

The tracking page renders the complete parcel journey as literal React Flight records. The
adapter parses those records without executing scripts, reads the `ParcelJourneyItems`
component and requires the displayed parcel ID to match the request. Component ids and bundle
names can change without changing that contract. Scan timestamps are explicit UTC instants;
recipient contacts, collection codes, dimensions and delivery actions are excluded.

Links are restricted to the carrier's HTTPS host, one parcel and one verification code. Older
notification addresses can redirect to the current recipient page on that host. A rejected or
expired link stays inconclusive: it does not prove that a parcel is missing. Request and
response diagnostics are excluded because they can carry the notification's capability.

Only the current recipient page's server-rendered journey is supported. A page that needs
recipient verification or returns a different data layout passes to enabled universal providers.

Set `INSTABOX_TRACKING_NUMBER` and `INSTABOX_TRACKING_URL` outside the repository and run
`npm run test:carriers:live -- carriers/instabox/adapter.live.test.ts`.
