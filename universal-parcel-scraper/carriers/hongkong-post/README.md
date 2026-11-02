# Hongkong Post

Reads the latest status of checksum-valid postal item numbers ending in `HK` from
Hongkong Post's official enquiry chatbot (Talk2Elain). The result is a summary: one
status wording and its clock, with no history.

## How it works

1. `direct`: one chatbot session per lookup, under a fresh random session id. Each input
   is posted to `https://chatbot.hongkongpost.hk/mw/web`; the bot's reply comes from
   `https://chatbot.hongkongpost.hk/mw/web/longPoll`, one message per poll. The adapter
   walks the scripted menu (`init`, English, Mail Tracing and Compensation, Mail Tracing),
   checks that each reply offers the expected option under its expected label and that the
   last one asks for a tracking number, then sends the number. An idle poll ends with HTTP
   408. Like the official client, the adapter polls again after it, or after a reply
   without a message, a bounded number of times within the budget. A session end or a
   hand-over to live chat stops the lookup.

## Notes

- The answer does not repeat the number. It is bound to the lookup because the session is
  new, carries only this number, sends it once as its last input, and the answer is the
  first message after it. A menu, prompt or "information entered is incorrect" reply in its
  place is a changed menu, never a not-found.
- "The system has no record of the mail item enquired" is not found. Hongkong Post gives
  the same answer for an item past its enquiry period. "Invalid Mail Number!" is an
  invalid number.
- The status clock (`as at DD-MM-YYYY HH:mm`) is the latest event's, in local time where it
  happened, which for an outward item is often the destination. It stays in
  `last_update_local` without an offset; the catalog keeps `UTC` for that reason.
- The chatbot repeats Hongkong Post's history wordings. Known ones map through
  `status.ts`; others fall to the shared wording rules, and stay unmapped when those don't
  know them either.
- Only the first line of the answer is read. The contact link and menu lines after it are
  dropped.

## Other tracking routes

The [official tracker](https://webapp.hongkongpost.hk/en/mail_tracking2/index.html)
uses MTCaptcha before posting to
`/api1/v1/mailTracking/mail-tracking-message-mtCaptcha` on
`webapp1.hongkongpost.hk` or `webapp2.hongkongpost.hk`.
MTCaptcha supports [invisible verification, text images and an audio alternative](https://docs.mtcaptcha.com/dev-guide).
The page obtains its own verification token; an accepted browser can proceed without
a visible puzzle. The bundled TRAWL image has no MTCaptcha solver. Its speech-to-text
support for reCAPTCHA does not handle MTCaptcha's widget or submission flow.
A capture must bind the visible widget's image or audio to that same challenge,
confirm verification and then validate the tracking reply for the requested item.
The older `MailTracking_app3/latestResult` route remains in the public page's client code.

The Android app `com.hkpost.android` links to the same chatbot. Its guest session
(`m.hongkongpost.hk/api/sign-in`, then a JWT) needs no account, but its tracking SOAP
calls (`MailTrackDetailCapt`, `MailTrackingRecordCapt`) refuse a request without a Tencent
Cloud CAPTCHA ticket. The [Mail Service API](https://ec-ship.hongkongpost.hk/API-portal/index.jsp?lang=en_us)
requires registration. None of them is used.

## Limitations

- Latest status only: no event history, place, delivery estimate or offset.
- Only `S10` numbers ending in `HK`.
- Outbound tracking beyond departure from Hong Kong depends on the destination's
  postal service.
- A lookup costs ten requests: five inputs and the polls that collect their replies. A
  reworded or reordered menu fails until the expected labels are updated.

## Testing

`npm run test:carriers:live -- carriers/hongkong-post` sends a well-formed unknown number.
Set `HONGKONG_POST_TRACKING_NUMBER` to a real number to read one status.
