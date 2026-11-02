# SkyNet South Africa

SkyNet South Africa is the South African member of the SkyNet Worldwide Express network. It
runs its own domestic courier service and delivers the network's parcels flown into South
Africa. Tracked through its tracking page's own connection.

## How it works

1. `direct`: SkyTrack on `web.skynet.co.za:5002` is a Blazor Server app on ASP.NET Core 8. Its
   HTML is an empty shell, and the server renders the page over a SignalR connection. The
   adapter holds that connection over HTTP long polling, with no browser, cookie, token or key:
   - `GET /T?R={number}`, the shell, which names the two components to start and carries
     their state.
   - `POST /_blazor/negotiate?negotiateVersion=1` for a connection token.
   - Polls and posts on `/_blazor?id={token}`: the `blazorpack` handshake, `StartCircuit` with
     the page's address, its components and their state, then each render batch the server
     sends, acknowledged as the browser does, until the page lists the waybill or says it is
     unknown.
   - `DELETE` on the same address, so the server drops the circuit at once.

- The shared Blazor Server client holds the connection, in
  [`blazorCircuit.ts`](../../core/transport/blazorCircuit.ts), and the protocol, in
  [`blazor.ts`](../../core/transport/blazor.ts): the MessagePack hub messages, the render batch
  layout with the frames ASP.NET Core 8 adds and the document the batches build, which the
  parser reads as HTML. The adapter has it hand the circuit's start the shell's component state.
- The page looks the number up as it opens. Its scripts set up the search box and other
  widgets; the adapter answers each call as done and refuses a move to another page.
- An unknown number renders `{number} NOT FOUND` under the search box, which counts once the
  server has started the page.
- A 403 or a browser check in place of the shell is a challenge, and a 429 is rate limited. A
  page the server will not start, a closed connection, a rendering error or a page that never
  shows an answer is a failure, not a missing parcel.
- The tracker looks the number up as a waybill, an invoice or account number and a sender's
  reference, and lists every waybill it finds with its references and scans. The adapter reads
  only the waybill the number names. A number found only among other shipments' references is
  inconclusive, and the other waybills are not read.
- There is no recognition. No detection rule names SkyNet South Africa, so preflight never
  offers it a number, and each lookup is a connection of several requests.

## Notes

- Each scan has a day and a wall clock to the second. The page names no zone, so the clocks
  stay `local_time`.
- The page lists scans newest first. Events are sorted by their clocks, keeping the page's
  order within a second, and a repeated scan is kept once.
- The tracker files some records under its own `HostServer` branch, such as a proof of
  delivery scanned in. That branch is not a place; other scans keep their branch as the
  location.
- The proof of delivery, its scanned image, the email telling the recipient the parcel is out
  and a duty recorded as paid move nothing. The newest scan with a stage is the current stage.
- A parcel flown in is created at the airport branch, lands, passes customs and is then
  collected by courier for its delivery branch.
- The waybill's references are not kept.

## Limitations

- No delivery estimate, weight, service, sender, recipient or proof of delivery, and no scan
  time as an instant.
- A parcel flown in shows its history from its landing in South Africa only.

## Numbers

When SkyNet's WooCommerce plugin books a parcel it offers the client's SkyNet code with the
shop's order number, and SkyNet returns the waybill number. Waybills on SkyTrack are twelve
digits, sometimes written with a leading `R`, and older ones mix letters and digits. Other
carriers share these shapes, so no rule claims them. The adapter accepts six to twenty letters
and digits. International SkyNet shipments use the network's shared tracker, covered by SkyNet
Worldwide Express. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

SkyTrack reads a waybill number from `R` on `web.skynet.co.za:5002/T`; SkyNet's WooCommerce
plugin links each booked waybill there, so one parcel opens at
`web.skynet.co.za:5002/T?R={number}`. The older tracker read it from `wb` on
`www.skynet.co.za/tracking2/tracking.aspx`.

## Testing

`npm run test:carriers:live -- carriers/skynet-sa`, with `SKYNET_SA_TRACKING_NUMBER` and
optionally `SKYNET_SA_UNKNOWN_NUMBER` set outside the repository.
