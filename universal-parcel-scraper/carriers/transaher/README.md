# Transaher

Transaher is a Spanish transport and logistics group that delivers parcels across Spain and
Portugal, including home deliveries for online shops. Tracked through its tracking page's own
connection.

## How it works

1. `direct`: Transaher's tracker on `clientes.transaher.es/webclient/` is a Blazor Server app.
   Its HTML is an empty shell, and the server renders the shipment over a SignalR connection.
   The adapter holds that connection over HTTP long polling, with no browser, cookie, token or
   key:
   - `GET /webclient/tracking/-5,0,{number}`, the shell, which names the component to start.
   - `POST /webclient/_blazor/negotiate?negotiateVersion=1` for a connection token.
   - Polls and posts on `/webclient/_blazor?id={token}`: the `blazorpack` handshake,
     `StartCircuit` with the page's address and component, then each render batch the server
     sends, acknowledged as the browser does, until the page shows the shipment or says the
     number is unknown.
   - `DELETE` on the same address, so the server drops the circuit at once.

- The shared Blazor Server client holds the connection, in
  [`blazorCircuit.ts`](../../core/transport/blazorCircuit.ts), and the protocol, in
  [`blazor.ts`](../../core/transport/blazor.ts): the MessagePack hub messages, the render batch
  layout and the document the batches build, which the parser reads as HTML. The adapter gives
  it the page, the answers to the page's script calls, the moves it follows and when the page
  has answered.
- The tracking box opens `htracking`, which asks the browser whether it runs on a phone and
  moves a desktop to `tracking`. The adapter opens `tracking`, answers the device check as a
  desktop and follows a move only to the requested number's own page.
- An unknown number renders `No se ha encontrado la expedición indicada.` in place of the
  shipment, which counts once the server has started the page.
- A 403 or a browser check in place of the shell is a challenge, and a 429 is rate limited. A
  page the server will not start, a closed connection, a rendering error or a page that never
  shows an answer is a failure, not a missing parcel.
- The summary's expedition number, an agency and a serial such as `123-4567890`, must appear
  in the requested number.
- Recognition makes the same lookup.

## Notes

- Each situation has a day and a wall clock to the second. The page names no zone, so the
  clocks stay `local_time`.
- The grid lists situations oldest first but does not always keep their order: one history
  files the delivery van after the delivery. Events are sorted by their clocks, and a repeated
  situation is kept once.
- The summary's status heads the page and follows its progress rail, which can lag the
  history. It decides a delivery; otherwise the further of the summary and the newest staged
  situation is the current stage. A note to agree a day and time to unload moves nothing.
- The sender is kept. The recipient, the sender's reference, the shipping day, the progress
  rail and the proof of delivery are not. The situations name no place.

## Limitations

- The grid shows a long history a page at a time, oldest first. The adapter reads the first
  page and marks such a history truncated; the summary still gives the current stage.
- No location, delivery estimate or weight, and no delivery time as an instant.

## Numbers

The tracking box on transaher.es accepts only numbers that start with `103`, and the site's
other tracking form requires exactly 27 digits. Archived lookups on Transaher's tracker carry
numbers of that layout. `transaher-1` claims 27 digits starting `103`, which no other carrier
rule matches. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking box opens `clientes.transaher.es/webclient/htracking/-5,0,` followed by the
number; archived lookups also use the same address with `tracking` in place of `htracking`.

## Testing

`npm run test:carriers:live -- carriers/transaher`, with `TRANSAHER_TRACKING_NUMBER` and
optionally `TRANSAHER_UNKNOWN_NUMBER` set outside the repository.
