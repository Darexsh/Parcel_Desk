# Sagawa Express

Reads the current state of a Sagawa Japanese domestic waybill (10 or 12 digits, printed
hyphens dropped) through the official app's home-screen widget. The answer is a status
only: no history, no scan times, no places. The official tracking link is recognized.

## Why the widget

Sagawa suspended its public shipment inquiry service and its inquiry API after
unauthorized access to the inquiry service, as its
[official service FAQ](https://www2.sagawa-exp.co.jp/information/detail/425/) explains; it
asks customers to call their local office for a parcel's progress. No shipment history can
be read from Sagawa while that lasts. The widget of the Android app
`jp.co.sagawa.SagawaOfficialApp` still answers with one state per waybill, and that is all
this adapter reads. The app shows history only by opening the suspended inquiry page.

## How it works

1. `app`: `POST https://www.e-service.sagawa-exp.co.jp/o/wtx/rest/apiOfficialApp/UpdateWidget`
   with the JSON body `{"trackingNo": number, "callType": "2"}`. `callType` 2 is the
   widget's periodic refresh; 1 registers a widget and refuses a delivered parcel, so it
   is never sent. No account, session or device token is involved.
2. The request carries the app's `X-Api-Key`. That key is compiled into the app, the same
   for every install, and is included with the maintainer's approval. Without it the edge
   answers Access Denied.
3. The User-Agent is the host's own (`SCRAPER_USER_AGENT`, or the package default) unless
   it names a browser, in which case the app's `okhttp/3.10.0` is sent. The Akamai edge in
   front of the API has refused browser User-Agents with its Access Denied page, and the
   app never sends one.

## Reading the answer

- The reply's `baggageInfo.trackingNo` must be the waybill asked for; anything else is a
  schema error. Nothing is read before that check.
- The result has `summary_only: true`, no events, the four-digit state code as
  `provider_code` and the state sentence as `last_status_text`. `last_update` and
  `expected_delivery` stay null: the reply has no time at all, and none is invented.
- Only the delivered code is mapped, from live replies. The app declares three more codes
  but never uses or explains them, so they and any other code stay `unknown` with no
  stage.
- A sentence that looks like it names a phone number keeps only its `【…】` label.
  Nothing else in the reply is projected.

## Failures

- A `422` carrying only the widget's no-data error (お荷物データが登録されておりません) is
  not found. The widget says the same for a waybill that is not registered yet, one past
  the inquiry window and one that never existed, and does not tell them apart.
- Any other `422` refusal is inconclusive, and a malformed reply is a schema error.
- `401` and `403` are challenges, never not found, and so is an HTML page in place of a
  `200` or `422` JSON reply. `429` is rate limited and keeps `Retry-After`; `404` and
  `410` are transport failures. Any other status keeps its HTTP kind whatever the body, so
  a `503` error page is maintenance with its `Retry-After`, not a challenge.
- Network failures are reported without the request, so the key never reaches a
  diagnostic.

## Limitations

- No history: the widget has a single state.
- Numeric waybills overlap Japan Post, Yamato and other carriers, so their shape does not
  select Sagawa automatically; detection only suggests it, among others, for 12 digits
  whose last digit is the remainder of the first eleven divided by seven. Choose the
  carrier explicitly for a ten-digit waybill or to skip the other suggestions.
- A revoked key needs a new release; there is no automatic refresh.

## Testing

`npm run test:carriers:live -- carriers/sagawa` sends a well-formed waybill the widget has
no data for. Set `SAGAWA_TRACKING_NUMBER` to a real waybill, outside Git, to read one state.
