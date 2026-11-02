# Chunghwa Post

Reads Chunghwa Post's international postal tracking through its public image-CAPTCHA flow.

## Retrieval

The [official tracker](https://postserv.post.gov.tw/pstmail/main_mail.html) opens a session
through `SessionServlet` and creates a four-digit JPEG through `jcaptcha` with a fresh UUID.
The adapter uses the shared local [OCR model](../../core/transport/text-captcha-model/README.md)
and posts the same UUID, answer and one whole item to `EsoafDispatcher`, using the public
client's `EB500200` query envelope. One fresh challenge is allowed after an unreadable or
explicitly refused answer. Cookies and verification material stay within that lookup.

The server must confirm verification and repeat the requested item. The parser keeps scan
wording, event codes and processing locations. Recipient, dispatch-bag and expanded remark fields
are omitted. Only the server's explicit absence message for the requested item is not found.

## Clocks

Scan times carry no zone. A scan made by one of Chunghwa Post's own branches is dated on
`Asia/Taipei`: Taiwan keeps one zone without daylight saving. The branch is read as the
official client reads it: a branch code of digits or a `TW` office of exchange, on a row that
links no other post's website. The tracker's notes say a scan in the destination country is
on that country's local time, so a row abroad, which names the country and links its post,
keeps its wall clock in `local_time`, as does a row whose branch code is missing or of another
form.

## Numbers

Detection names Chunghwa Post for the EMS, parcel, registered and tracked-letter S10 items it
issues, C, E, L or R first, and for its express items to mainland China, which the tracker's
notes number FT or FZ beside EE and EZ: TW last and a passing check digit. No public FT or FZ
number is known, so that suffix and check digit follow its other series.
The tracker's notes say U letter post cannot be followed online, so detection leaves UH items
with international mail and its UH rule is low-confidence. The adapter still takes them when
Chunghwa Post is named: the tracker answered one with the scan a universal provider had. A
successful reply must confirm the whole item. Other U series remain unsupported.

Mail from abroad keeps the sending post's number. Chunghwa Post's
[ePacket page](https://www.post.gov.tw/post/internet/Postal/index.jsp?ID=1499060698896) says
tracked letters imported into Taiwan are followed on its tracker, and [Taipei Customs](https://web.customs.gov.tw/taipei/singlehtml/3130?cntId=cus2_164078_3130)
sends the recipients of registered parcels from abroad there with the parcel's own number. So
Chunghwa Post is the destination post an item for Taiwan is handed to, except a `U` customs
label, which its tracker cannot read.

## Limitations

The direct path supports international EMS, parcel, registered and tracked-letter S10 items,
and Taiwan-issued FT and FZ express items and UH letter post.
It refuses other postal services, numeric domestic references and proprietary mainland
formats as invalid input before any request; enabled universal providers follow them.
The tracker retains six months of history, and destination posts can withhold scans. Its
notes say thirteen posts, the United States', the United Kingdom's and France's among them,
no longer give online tracking of registered letters.
A return to the sender shows only in the remark of an unsuccessful delivery, which the adapter
discards.
Scans abroad have no instant, so an item that has left Taiwan has a wall clock as its last update.
No cheap HTTP recognition is declared. Changed image geometry remains a challenge.

## Testing

Set `CHUNGHWA_POST_TRACKING_NUMBER` outside Git and run
`npm run test:carriers:live -- carriers/chunghwa-post`. `CHUNGHWA_POST_UNKNOWN_NUMBER` checks an unknown item.
